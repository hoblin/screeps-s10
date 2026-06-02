import { log } from "./Logger.js";

// ============================================================================
//  RoadPlanner — plans roads along the colony's hot paths (each source ↔ spawn,
//  spawn ↔ controller) and keeps their construction sites alive. A road halves
//  move cost (1 fatigue/step vs 2 on plain, 10 on swamp), so the routes haulers
//  and workers walk every tick get faster round trips — and bodies can afford
//  fewer MOVE parts (issue #14).
//
//  Pure geometry, mirroring ExtensionPlanner / ContainerPlanner: planTiles() is
//  a deterministic function of terrain + endpoint positions, so the owning
//  HiveCluster computes it once and caches it; only ensureSites() runs the
//  lifecycle each tick.
// ============================================================================

// How many road construction sites we keep queued at once. Roads are a long,
// low-priority backlog (workers build them after extensions); queuing the whole
// network up front would hog the global 100-site cap and bury higher-priority
// sites. We refill the queue as roads finish, so the network still completes —
// just in waves. No silent truncation: ensureSites logs when it hits the cap.
const MAX_PENDING_ROAD_SITES = 10;

export const RoadPlanner = {
  key(x, y) {
    return `${x},${y}`;
  },

  // The deduped set of tiles the roads should cover. `legs` is a list of
  // { from, to } RoomPosition pairs; each leg's shortest path contributes its
  // tiles. Terrain type is neutralised (swampCost = plainCost) because a road
  // makes swamp and plain equally cheap, so we want the geometrically shortest
  // road, not one that detours around swamp. Endpoint tiles (containers, spawn)
  // come back in the path but are filtered out at placement time by occupied().
  planTiles(room, legs) {
    const tiles = new Map(); // "x,y" -> { x, y }, dedupes overlapping legs
    for (const { from, to } of legs) {
      if (!from || !to) continue;
      const path = from.findPathTo(to, { ignoreCreeps: true, swampCost: 1 });
      for (const step of path) {
        tiles.set(this.key(step.x, step.y), { x: step.x, y: step.y });
      }
    }
    return [...tiles.values()];
  },

  // True if `pos` already holds something that blocks a new road. A road may
  // share a tile only with a rampart; every other structure — including an
  // existing road — blocks it, as does any construction site. (Same blocked-tile
  // test as ExtensionPlanner.occupied: both ask "can a plain structure go here".)
  occupied(pos) {
    return pos.look().some(
      (item) =>
        (item.type === LOOK_STRUCTURES &&
          item.structure.structureType !== STRUCTURE_RAMPART) ||
        item.type === LOOK_CONSTRUCTION_SITES
    );
  },

  // Keep road construction sites alive on the planned tiles, up to the pending
  // cap. Idempotent: tiles that already hold a road (or anything else) are
  // skipped, so it's safe to call every tick. Non-OK createConstructionSite
  // results (the global 100-site cap, RCL gating) are logged, never thrown.
  ensureSites(room, tiles, maxPending = MAX_PENDING_ROAD_SITES) {
    const pending = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    }).length;
    let budget = maxPending - pending;
    if (budget <= 0) return;

    for (const { x, y } of tiles) {
      if (budget <= 0) break;
      const pos = new RoomPosition(x, y, room.name);
      if (this.occupied(pos)) continue;

      const result = room.createConstructionSite(pos, STRUCTURE_ROAD);
      if (result === OK) {
        budget--;
      } else if (result === ERR_FULL) {
        // Global construction-site cap — no point trying more tiles this tick.
        log.warn(`[${room.name}] road site failed: ${result}`);
        break;
      } else if (result !== ERR_INVALID_TARGET) {
        // ERR_INVALID_TARGET = a tile we couldn't detect as occupied; skip it
        // quietly. Anything else is worth surfacing.
        log.warn(`[${room.name}] road site at ${pos} failed: ${result}`);
      }
    }
  },
};
