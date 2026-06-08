import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  Soldier (#259) — the OperationalMilitaryOverlord's unit: a THIN state machine like Combatant, with
//  no conduct of its own. Its behaviour is entirely COMPOSED from the behavior set the overlord stamps
//  at spawn (creep.memory.behaviors) and driven each tick by the per-creep BehaviorMachine.
//
//  A DISTINCT role from Guard ("guard") and Combatant ("combatant") so the operational overlord claims
//  its own units without contending the legacy GuardOverlord / WarbandOverlord (singletons that still
//  own those roles until their missions migrate here). This is the forward role the unified military
//  domain grows into as defend/clear/retaliate/manual-offense fold in.
// ============================================================================
export class Soldier extends Role {
  // Combat rank, same as Guard/Combatant — it has somewhere to be and shouldn't be shoved by idlers.
  static movementPriority = 3;

  static run(creep, colony) {
    BehaviorMachine.run(creep, colony);
  }
}
