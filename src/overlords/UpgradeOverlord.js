import { Overlord } from "./Overlord.js";
import { Upgrader } from "../roles/Upgrader.js";
import { Hauler } from "../roles/Hauler.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { stageAtLeast } from "../lib/Stages.js";
import { log } from "../lib/Logger.js";

// ============================================================================
//  UpgradeOverlord — keeps the room controller leveling.
//
//  Besides spawning upgraders, this overlord owns the CONTROLLER CONTAINER: a
//  container hugging the controller that haulers keep filled so upgraders park
//  beside it and pull energy from one tile away instead of walking all the way
//  back to a source container each cycle. Mirrors MiningOverlord's container
//  lifecycle: compute the tile once (cached in colony memory), then keep a
//  construction site alive on it until the container is finished.
// ============================================================================
export class UpgradeOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 4 });
  }

  get role() {
    return "upgrader";
  }

  desiredCount() {
    // 1 baseline; 2 once we have some extension capacity.
    return this.room.energyCapacityAvailable >= 550 ? 2 : 1;
  }

  bodyFor(energy) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 4, energy });
  }

  runCreep(creep) {
    Upgrader.run(creep, this.colony);
  }

  // --------------------------------------------------------------------------
  //  Controller-container position: the tile a hauler fills and an upgrader
  //  parks beside. Heuristic mirrors MiningOverlord.computeMiningPosition: of
  //  all walkable tiles adjacent to the controller, pick the one closest (by
  //  path) to the nearest hauler origin (a source container, else a spawn) —
  //  that minimises the hauler round-trip. Computed once and cached in colony
  //  memory so we don't re-path every tick.
  // --------------------------------------------------------------------------
  get controllerContainerPosition() {
    const cache = this.controllerContainerPositionCache;
    if (cache) {
      return new RoomPosition(cache.x, cache.y, cache.roomName);
    }
    const { position, reachedByPath } = this.computeControllerContainerPosition();
    // Only cache a tile we genuinely reached by path. Caching a transient
    // pathing-failure fallback would make a temporary glitch permanent.
    if (position && reachedByPath) {
      this.controllerContainerPositionCache = {
        x: position.x,
        y: position.y,
        roomName: position.roomName,
      };
    }
    return position;
  }

  get controllerContainerPositionCache() {
    return Memory.colonyData?.[this.colony.name]?.controllerContainerPos;
  }

  set controllerContainerPositionCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].controllerContainerPos = value;
  }

  // Walkable controller-adjacent tile nearest (by path) to a hauler origin.
  // Returns { position, reachedByPath }: reachedByPath is false when no tile was
  // pathable and we had to fall back, so the caller can avoid caching it.
  computeControllerContainerPosition() {
    const controller = this.colony.controller;
    if (!controller) return { position: null, reachedByPath: false };

    const anchor = this.haulerAnchor();
    const walkableNeighbours = this.walkableTilesAround(controller.pos);
    if (walkableNeighbours.length === 0) {
      return { position: null, reachedByPath: false };
    }

    let best = null;
    let bestPathLength = Infinity;
    for (const tile of walkableNeighbours) {
      const path = anchor.pos.findPathTo(tile, { ignoreCreeps: true });
      // Unreachable tiles return a path that doesn't end at the tile.
      const reaches =
        path.length > 0 &&
        path[path.length - 1].x === tile.x &&
        path[path.length - 1].y === tile.y;
      const length = reaches ? path.length : Infinity;
      if (length < bestPathLength) {
        bestPathLength = length;
        best = tile;
      }
    }

    if (best) return { position: best, reachedByPath: true };
    // No tile was pathable: fall back to the first walkable tile so the upgrader
    // can still park somewhere, but DON'T let the caller cache this guess.
    return { position: walkableNeighbours[0], reachedByPath: false };
  }

  // Where haulers come from: prefer the nearest source container (the actual
  // hauler trip origin), else the first spawn, else the controller itself. This
  // is the anchor we minimise the controller-container distance against.
  haulerAnchor() {
    const sourceContainers = this.colony.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        Hauler.isSourceContainer(s, this.colony),
    });
    if (sourceContainers.length > 0) {
      return this.colony.controller.pos.findClosestByPath(sourceContainers) || sourceContainers[0];
    }
    return this.colony.spawns[0] || this.colony.controller;
  }

  // The 8 tiles around a position that aren't walls.
  walkableTilesAround(position) {
    const terrain = this.room.getTerrain();
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = position.x + dx;
        const y = position.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        tiles.push(new RoomPosition(x, y, position.roomName));
      }
    }
    return tiles;
  }

  // --------------------------------------------------------------------------
  //  Controller-container lifecycle: make sure a container (or its construction
  //  site) exists on the controller-container position. Haulers fill it; parked
  //  upgraders pull from it. Gated on the 2b:Hauling stage (a source container
  //  is finished, so haulers exist to keep this one stocked).
  // --------------------------------------------------------------------------
  ensureControllerContainerSite() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return;

    const position = this.controllerContainerPosition;
    if (!position) return;

    const thingsHere = position.look();
    const hasContainer = thingsHere.some(
      (item) =>
        item.type === LOOK_STRUCTURES &&
        item.structure.structureType === STRUCTURE_CONTAINER
    );
    const hasSite = thingsHere.some(
      (item) =>
        item.type === LOOK_CONSTRUCTION_SITES &&
        item.constructionSite.structureType === STRUCTURE_CONTAINER
    );
    if (hasContainer || hasSite) return;

    // Place the container site. We early-return once a site or container exists,
    // so this won't spam. Log unexpected failures (e.g. the 5-container/room or
    // 100-site global caps) so a silently-missing container is debuggable. Never
    // throw — ERR_RCL_NOT_ENOUGH / ERR_FULL just get logged.
    const result = this.room.createConstructionSite(position, STRUCTURE_CONTAINER);
    if (result !== OK) {
      log.warn(
        `[${this.colony.name}] controller container site at ${position} failed: ${result}`
      );
    }
  }

  // Called by Colony each tick. Keeps the controller-container site alive (once
  // the hauling stage is active) before driving the upgraders.
  run() {
    this.ensureControllerContainerSite();
    super.run();
  }
}
