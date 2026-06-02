import { Colony } from "./Colony.js";
import { log } from "./lib/Logger.js";
import { Dashboard } from "./lib/Dashboard.js";

// ============================================================================
//  Kernel — the top-level orchestrator (think: the Rails app object).
//  Responsibilities:
//   - CPU bucket guard (skip expensive work when starved)
//   - discover owned rooms and wrap each in a Colony
//   - drive the per-tick pipeline
//   - cleanup dead creep memory
// ============================================================================
export class Kernel {
  constructor() {
    this.colonies = {};
  }

  tick() {
    this.cleanupMemory();
    this.migrateLegacyHarvesters(); // must precede buildColonies (it groups by role)

    // Bucket guard: if CPU bucket is low, run only the essentials.
    const lowBucket = Game.cpu.bucket < 500;
    if (lowBucket) {
      log.warn(`Low CPU bucket (${Game.cpu.bucket}); running minimal tick.`);
    }

    this.buildColonies();

    for (const name in this.colonies) {
      try {
        this.colonies[name].run(lowBucket);
      } catch (err) {
        log.error(`Colony ${name} crashed: ${err.stack || err}`);
      }
    }

    // Telemetry: write Memory.status every tick (instant pull), log summary
    // periodically. Always run — status is cheap and most useful when starved.
    Dashboard.run(this.colonies);
  }

  // Wrap every owned room (with a spawn) in a Colony object.
  buildColonies() {
    this.colonies = {};
    for (const name in Game.rooms) {
      const room = Game.rooms[name];
      if (room.controller && room.controller.my) {
        this.colonies[name] = new Colony(room);
      }
    }
  }

  // Release memory of creeps that no longer exist.
  cleanupMemory() {
    if (!Memory.creeps) return;
    for (const name in Memory.creeps) {
      if (!(name in Game.creeps)) {
        delete Memory.creeps[name];
      }
    }
  }

  // One-time migration: the Stage 2 refactor renamed the mobile "harvester"
  // role to the static "miner" role, owned per-source by a MiningOverlord.
  // Any harvester alive at deploy time would otherwise be orphaned (no overlord
  // drives it) while a fresh miner spawns alongside it — a wasteful duplicate.
  // Re-tag living harvesters as miners so the new overlords adopt them and let
  // them live out their days under management. Safe to run every tick; it only
  // touches creeps still carrying the legacy role.
  migrateLegacyHarvesters() {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.role !== "harvester") continue;

      creep.memory.role = "miner";

      // Every migrated creep MUST end up bound to a MiningOverlord, otherwise no
      // overlord claims it (orphan) AND it counts toward no quota (so a fresh
      // miner spawns as a duplicate). The legacy Harvester assigned its source
      // lazily, so a creep that hadn't run yet (or was still spawning) has no
      // sourceId. In that case, pick the source nearest the creep so it binds
      // to a real overlord.
      let sourceId = creep.memory.sourceId;
      if (!sourceId) {
        const nearestSource = creep.pos.findClosestByRange(FIND_SOURCES);
        sourceId = nearestSource ? nearestSource.id : null;
        creep.memory.sourceId = sourceId;
      }
      if (!sourceId) continue; // no sources visible at all — leave as-is

      // Bind to the MiningOverlord of that source. The identifier must match
      // MiningOverlord.identifier exactly ("miner:<full-sourceId>").
      creep.memory.overlord = `miner:${sourceId}`;
      // The overlord re-stamps miningPos on adopted creeps that lack it (see
      // MiningOverlord.run), and Miner.run falls back to the source directly
      // when miningPos is still null, so no creep ever gets stuck.
      creep.memory.miningPos = null;
    }
  }
}
