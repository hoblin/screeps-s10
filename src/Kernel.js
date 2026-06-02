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
      // Bind it to the MiningOverlord of whichever source it was already mining
      // (or its first source) so identifiers line up: "miner:<sourceId-suffix>".
      const sourceId = creep.memory.sourceId;
      if (sourceId) {
        creep.memory.overlord = `miner:${sourceId.slice(-5)}`;
        creep.memory.miningPos = null; // let the overlord re-stamp if needed
      }
    }
  }
}
