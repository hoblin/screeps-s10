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
}
