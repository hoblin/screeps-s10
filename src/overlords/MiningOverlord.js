import { Overlord } from "./Overlord.js";
import { Miner } from "../roles/Miner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

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
//  Each instance is identified by `mine:<sourceId-suffix>` so its miner is never
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
    // Use a short, stable suffix of the source id as the instance identifier.
    super(colony, { priority: 1, instanceId: source.id.slice(-5) });
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
  // exactly matches a source's 3000-energy-per-300-tick regen), plus ONE MOVE to
  // shuffle into position. No CARRY — energy drops into the container.
  bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE], {
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
    const computed = this.computeMiningPosition();
    if (computed) {
      this.miningPositionCache = {
        x: computed.x,
        y: computed.y,
        roomName: computed.roomName,
      };
    }
    return computed;
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
  computeMiningPosition() {
    const anchor = this.colony.spawns[0] || this.colony.controller;
    const walkableNeighbours = this.walkableTilesAround(this.source.pos);
    if (walkableNeighbours.length === 0) return null;

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
    // Fall back to the first walkable tile if pathing failed for all.
    return best || walkableNeighbours[0];
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

    this.room.createConstructionSite(position, STRUCTURE_CONTAINER);
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

  // Called by Colony each tick (in addition to run()) so the container site is
  // kept alive even before the miner exists.
  run() {
    this.ensureContainerSite();
    super.run();
  }
}
