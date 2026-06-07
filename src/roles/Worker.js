import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  Worker — the colony's general-purpose builder/filler/repairer/upgrader, now a THIN STATE
//  MACHINE (#239) like the combat roles. No procedural conduct of its own: all behaviour lives
//  in the `work` economy behaviour (gather↔work cycle ⊕ a fallback of fill/build/repair/upgrade
//  atoms), driven each tick by the per-creep BehaviorMachine. The WorkOverlord steers it by
//  stamping memory.buildTarget (the build site) — the same command pattern the remote haulers use.
// ============================================================================
export class Worker extends Role {
  // Build/repair/fill is important but interruptible — yields the tile to logistics
  // (miner/hauler), outranks pure idling.
  static movementPriority = 3;

  // The role's conduct set — one node, no edges. The WorkOverlord stamps this at spawn.
  static behaviors = { default: "work" };

  static run(creep, colony) {
    // Self-heal the behaviour set for workers that predate the #239 lift (no memory.behaviors).
    if (!creep.memory.behaviors) creep.memory.behaviors = Worker.behaviors;
    BehaviorMachine.run(creep, colony);
  }
}
