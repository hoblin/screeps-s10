import { Hatchery } from "./hiveClusters/Hatchery.js";
import { MiningOverlord } from "./overlords/MiningOverlord.js";
import { LogisticsOverlord } from "./overlords/LogisticsOverlord.js";
import { UpgradeOverlord } from "./overlords/UpgradeOverlord.js";
import { WorkOverlord } from "./overlords/WorkOverlord.js";
import { DefenseOverlord } from "./overlords/DefenseOverlord.js";
import { log } from "./lib/Logger.js";

// ============================================================================
//  Colony — everything owned around a single room controller.
//  (Overmind term. Think of it as a per-room aggregate / service container.)
//
//  A Colony wires together:
//   - HiveClusters: physical sub-systems (Hatchery = spawns+extensions)
//   - Overlords: goal-oriented managers that own a set of creeps + a job
//
//  The Colony itself holds no creep logic; it delegates to overlords.
// ============================================================================
export class Colony {
  constructor(room) {
    this.room = room;
    this.name = room.name;
    this.controller = room.controller;
    this.spawns = room.find(FIND_MY_SPAWNS);
    // Nearest-spawn-first: the first MiningOverlord (and thus the bootstrap
    // miner) must seat on the source closest to the base, not whatever order
    // FIND_SOURCES happens to return — a far first source means long energy
    // hauls and a crawling cold-start RCL (issue #68).
    this.sources = this.orderSourcesNearestFirst(room.find(FIND_SOURCES));

    // Group this colony's living creeps by their role for cheap lookup.
    this.creepsByRole = this.groupCreeps();

    // HiveClusters (physical infrastructure)
    this.hatchery = new Hatchery(this);

    // Overlords (goal managers). Order matters for spawn priority.
    //
    // Mining is per-source: one MiningOverlord instance per source in the room.
    // This mirrors Overmind and means remote/outpost mining later is just
    // "spawn more MiningOverlords" rather than a structural change.
    const miningOverlords = this.sources.map(
      (source) => new MiningOverlord(this, source)
    );

    this.overlords = [
      ...miningOverlords,
      new WorkOverlord(this),
      new LogisticsOverlord(this), // requests 0 haulers until 2b:Hauling stage
      new UpgradeOverlord(this),
      new DefenseOverlord(this), // places + operates towers (no-op until RCL3)
    ];
  }

  groupCreeps() {
    const byRole = {};
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.colony !== this.name) continue;
      const role = creep.memory.role || "unknown";
      (byRole[role] ||= []).push(creep);
    }
    return byRole;
  }

  creepsWithRole(role) {
    return this.creepsByRole[role] || [];
  }

  // Order sources by ascending REAL path cost from the base to each source, so
  // the bootstrap miner lands on the spawn-closest source. Path cost (not raw
  // Chebyshev range) so a walled detour is ranked by the trip a hauler actually
  // walks. Source/spawn geometry is static, so the order is computed once and
  // cached in Memory (the same store the mining positions use); later ticks just
  // reorder by the cached id list, keeping the per-tick Colony rebuild cheap.
  orderSourcesNearestFirst(sources) {
    if (sources.length < 2) return sources;

    const byId = new Map(sources.map((source) => [source.id, source]));
    const cached = Memory.colonyData?.[this.name]?.sourceOrder;
    if (cached) {
      const ordered = cached.map((id) => byId.get(id)).filter(Boolean);
      // Trust the cache only while it still covers exactly the room's sources.
      if (ordered.length === sources.length) return ordered;
    }

    const anchor = this.spawns[0] || this.controller;
    if (!anchor) return sources; // can't rank without a base anchor yet

    const ranked = sources
      .map((source) => ({ source, cost: this.pathCostTo(anchor.pos, source) }))
      .sort(
        (a, b) =>
          a.cost - b.cost || (a.source.id < b.source.id ? -1 : 1) // stable tiebreak by id
      );

    // Don't cache a transient pathing failure as the permanent order.
    if (ranked.every((entry) => entry.cost < Infinity)) {
      Memory.colonyData ||= {};
      Memory.colonyData[this.name] ||= {};
      Memory.colonyData[this.name].sourceOrder = ranked.map((entry) => entry.source.id);
    }

    return ranked.map((entry) => entry.source);
  }

  // Path-step count from `anchorPos` to a tile adjacent to `source` (the source
  // tile itself is an obstacle — the miner stands at range 1). Infinity when the
  // source can't be reached, so unreachable sources sort last.
  pathCostTo(anchorPos, source) {
    const path = anchorPos.findPathTo(source.pos, { ignoreCreeps: true, range: 1 });
    const last = path[path.length - 1];
    const reaches = last && source.pos.getRangeTo(last.x, last.y) <= 1;
    return reaches ? path.length : Infinity;
  }

  run(lowBucket) {
    // 1. Each overlord decides what it wants (spawn requests) and runs its creeps.
    const spawnRequests = [];
    for (const overlord of this.overlords) {
      try {
        const req = overlord.generateSpawnRequest();
        if (req) spawnRequests.push(...[].concat(req));
        overlord.run();
      } catch (err) {
        log.error(`[${this.name}] Overlord ${overlord.constructor.name}: ${err.stack || err}`);
      }
    }

    // 2. Hatchery fulfils the highest-priority spawn request.
    if (!lowBucket) {
      this.hatchery.run(spawnRequests);
    }
  }
}
