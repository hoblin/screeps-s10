import { Overlord } from "./Overlord.js";
import { Miner } from "../roles/Miner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { log } from "../lib/Logger.js";

// ============================================================================
//  MiningOverlord — owns the static mining of ONE source (Overmind-style:
//  one overlord instance per source). The Colony creates one of these for each
//  source in the room, so remote/outpost mining later is just "more instances".
//
//  Responsibilities:
//   1. Decide the single tile a miner should stand on (the "mining position"),
//      which is also where the source's container belongs.
//   2. Keep a container construction site / container alive on that tile.
//   3. Spawn and drive exactly one static Miner for this source.
//
//  Each instance is identified by `miner:<full-sourceId>` so its miner is never
//  confused with another source's miner, even though they share the role
//  "miner".
// ============================================================================
export class MiningOverlord extends Overlord {
  /**
   * @param {Colony} colony
   * @param {Source} source - the specific source this overlord mines
   */
  constructor(colony, source) {
    // Mining is top priority: no energy income means no colony at all.
    // Use the FULL source id as the instance identifier. It's only a memory
    // string, so length doesn't matter, and a truncated suffix could collide
    // between two sources that share their last few chars.
    super(colony, { priority: 1, instanceId: source.id });
    this.source = source;
  }

  get role() {
    return "miner";
  }

  // One static miner per source is enough to fully drain it (5×WORK = 10/tick).
  desiredCount() {
    return 1;
  }

  // Static miner body: as many WORK parts as we can afford (capped at 5, which
  // exactly matches a source's 3000-energy-per-300-tick regen), plus TWO MOVE.
  // No CARRY — energy drops into the container.
  //
  // Why two MOVE for a creep that ultimately stands still: with 5 WORK the body
  // generates a lot of fatigue while travelling. One MOVE crawls on plains and
  // CANNOT cross swamp at all (it never clears 10 fatigue/step). Two MOVE lets
  // the miner reliably reach its position over mixed terrain on the one-way
  // trip; once parked, the extra MOVE costs nothing. Cheap insurance against
  // the "miner stuck en route" failure mode.
  bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE, MOVE], {
      extra: [WORK],
      max: 4, // template already has 1 WORK, so up to 5 WORK total
      energy: energyBudget,
    });
  }

  // --------------------------------------------------------------------------
  //  Mining position: the tile a miner parks on and the container sits under.
  //  Heuristic: of all walkable tiles adjacent to the source, pick the one
  //  closest (by path) to the colony's first spawn — that minimises hauler
  //  travel. Computed once and cached in the overlord's colony memory so we
  //  don't repeat the pathing every tick.
  // --------------------------------------------------------------------------
  get miningPosition() {
    const cache = this.miningPositionCache;
    if (cache) {
      return new RoomPosition(cache.x, cache.y, cache.roomName);
    }
    const { position, reachedByPath } = this.computeMiningPosition();
    // Only cache a tile we genuinely reached by path. Caching a transient
    // pathing-failure fallback would make a temporary glitch permanent.
    if (position && reachedByPath) {
      this.miningPositionCache = {
        x: position.x,
        y: position.y,
        roomName: position.roomName,
      };
    }
    return position;
  }

  get miningPositionCache() {
    return (Memory.colonyData?.[this.colony.name]?.miningPos || {})[this.source.id];
  }

  set miningPositionCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].miningPos ||= {};
    Memory.colonyData[this.colony.name].miningPos[this.source.id] = value;
  }

  // Walkable source-adjacent tile nearest (by path) to a spawn.
  // Returns { position, reachedByPath }: reachedByPath is false when no tile was
  // pathable and we had to fall back, so the caller can avoid caching it.
  computeMiningPosition() {
    const anchor = this.colony.spawns[0] || this.colony.controller;
    const walkableNeighbours = this.walkableTilesAround(this.source.pos);
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
    // No tile was pathable: fall back to the first walkable tile so a miner can
    // still stand somewhere, but DON'T let the caller cache this guess.
    return { position: walkableNeighbours[0], reachedByPath: false };
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
  //  Container lifecycle: make sure a container (or its construction site)
  //  exists on the mining position. Workers build the site; the miner drops
  //  energy into the finished container.
  // --------------------------------------------------------------------------
  ensureContainerSite() {
    const position = this.miningPosition;
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

    // Place the container site. ensureContainerSite early-returns once a site or
    // container exists, so this won't spam. Log unexpected failures (e.g. the
    // 100-site global cap) so a silently-missing container is debuggable.
    const result = this.room.createConstructionSite(position, STRUCTURE_CONTAINER);
    if (result !== OK) {
      log.warn(
        `[${this.colony.name}] container site at ${position} failed: ${result}`
      );
    }
  }

  // --------------------------------------------------------------------------
  //  Spawn request: stamp the source + mining position onto the new miner so it
  //  knows where to go without recomputing anything.
  // --------------------------------------------------------------------------
  generateSpawnRequest() {
    const request = super.generateSpawnRequest();
    if (!request) return null;

    const position = this.miningPosition;
    request.memory.sourceId = this.source.id;
    request.memory.miningPos = position
      ? { x: position.x, y: position.y, roomName: position.roomName }
      : null;
    return request;
  }

  runCreep(creep) {
    Miner.run(creep, this.colony);
  }

  // Called by Colony each tick. Keeps the container site alive even before any
  // miner exists, re-stamps the mining position onto any creep that lacks one
  // (e.g. creeps adopted via legacy migration), then drives the creeps.
  run() {
    this.ensureContainerSite();
    this.stampMiningPositionOnAssignedCreeps();
    super.run();
  }

  // Make sure every creep we own knows its mining position. New miners get it at
  // spawn time, but adopted (migrated) creeps may not — fill it in here so they
  // can park properly instead of relying on the source-direct fallback forever.
  stampMiningPositionOnAssignedCreeps() {
    const position = this.miningPosition;
    if (!position) return;
    for (const creep of this.assignedCreeps) {
      if (!creep.memory.miningPos) {
        creep.memory.miningPos = {
          x: position.x,
          y: position.y,
          roomName: position.roomName,
        };
      }
    }
  }
}
