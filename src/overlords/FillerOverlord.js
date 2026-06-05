import { Overlord } from "./Overlord.js";
import { Filler } from "../roles/Filler.js";

// ============================================================================
//  FillerOverlord — owns the storage→spawn-cluster filler (#152).
//
//  One filler per storage (a room has at most one storage, so this is 0 or 1). The
//  built storage IS the trigger — no stage gate needed; a storage can't exist before
//  RCL4 anyway. Priority ABOVE haulers: the delivery leg is short, and the filler's
//  presence keeps the spawn fed from the buffer, which speeds the spawning of every
//  other creep — so it's worth fielding ahead of the remote-fed hauler fleet. Miners
//  (1) and workers (2) still spawn first, so the recovery bootstrap is never starved.
// ============================================================================
export class FillerOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 2 });
  }

  get role() {
    return "filler";
  }

  // One filler per built storage (0 or 1). The storage's existence is the whole gate.
  desiredCount() {
    return this.colony.room.storage ? 1 : 0;
  }

  bodyFor(energyBudget) {
    return Filler.bodyFor(energyBudget);
  }

  runCreep(creep) {
    Filler.run(creep, this.colony);
  }
}
