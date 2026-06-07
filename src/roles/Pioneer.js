import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  Pioneer — bootstraps a freshly-claimed 2nd colony (#220).
//
//  The second half of the expansion directive. A claimed room is inert: a controller but no spawn, no
//  creeps, no energy. Pioneers are WORK+CARRY+MOVE generalists spawned from the MAIN colony that travel
//  danger-aware to the new room, self-harvest its sources, build its first spawn, then keep filling and
//  upgrading it through the fragile RCL1→3 bootstrap (#242) — a rich home pouring smart pioneers
//  compounds the new colony fast. ClaimOverlord stops the stream once the child reaches RCL3.
//
//  THIN ROLE over the behaviour paradigm (#239/#242): the conduct lives in the `pioneer` behaviour
//  (src/behaviors/economy/Pioneer.js — the Work cycle + a transit prefix, run on the child room); this
//  role just declares the behaviour set and delegates to the BehaviorMachine, mirroring Worker→Work.
//
//  Grouped under the HOME colony (memory.colony = home) so the home Hatchery builds them and
//  ClaimOverlord drives them; the room they SERVE is stamped separately (memory.bootstrapRoom).
// ============================================================================
export class Pioneer extends Role {
  // Build/seed work — interruptible, yields to logistics like a worker.
  static movementPriority = 3;

  // Route around hostile kill-zones on the long haul to the target (#145).
  static avoidHostiles = true;

  static behaviors = { default: "pioneer" };

  static run(creep, colony) {
    // Lifecycle guard: an orphaned pioneer (no target — e.g. a deploy that cleared the claim) has
    // nothing to serve, so recycle it home to reclaim its body cost rather than idle until it dies.
    if (!creep.memory.bootstrapRoom) return this.recycleAtHome(creep, colony);
    if (!creep.memory.behaviors) creep.memory.behaviors = Pioneer.behaviors;
    BehaviorMachine.run(creep, colony);
  }
}
