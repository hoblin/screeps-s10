import { Overlord } from "./Overlord.js";
import { Filler } from "../roles/Filler.js";

// ============================================================================
//  FillerOverlord — owns the storage→spawn-cluster filler (#152).
//
//  One filler per storage (a room has at most one storage, so this is 0 or 1). The
//  built storage IS the trigger — no stage gate needed; a storage can't exist before
//  RCL4 anyway. TOP priority (1, with Mining + Defense): the filler is what LOADS the
//  spawn + extensions from the storage buffer, so without it NOTHING spawns at full
//  size — it gates the spawning of every other creep (the warband included). A dead
//  filler is a spawn-loop emergency, so it's replaced before all routine economy.
// ============================================================================
export class FillerOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 1 });
  }

  get role() {
    return "filler";
  }

  // One filler per built storage (0 or 1) — but NONE while recovering: a collapsed colony's storage is
  // empty, so the filler has nothing to load, and the spawn energy it costs is exactly what the worker-only
  // bootstrap needs (workers self-fill the spawn until the economy is back, #282).
  desiredCount() {
    if (this.colony.health.recovering) return 0;
    return this.colony.room.storage ? 1 : 0;
  }

  bodyFor(energyBudget) {
    return Filler.bodyFor(energyBudget);
  }

  runCreep(creep) {
    Filler.run(creep, this.colony);
  }
}
