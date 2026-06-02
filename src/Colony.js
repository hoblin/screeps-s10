import { Hatchery } from "./hiveClusters/Hatchery.js";
import { MiningOverlord } from "./overlords/MiningOverlord.js";
import { LogisticsOverlord } from "./overlords/LogisticsOverlord.js";
import { UpgradeOverlord } from "./overlords/UpgradeOverlord.js";
import { WorkOverlord } from "./overlords/WorkOverlord.js";
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
    this.sources = room.find(FIND_SOURCES);

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
