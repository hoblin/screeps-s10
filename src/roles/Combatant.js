import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  LEGACY (#263): WarbandOverlord is retired — manual offence is now the RaidMission (the manual activation
//  source) on OperationalMilitaryOverlord, which spawns the "soldier" role. Nothing spawns "combatant" any
//  more; this role is kept registered only so in-flight combatants run out their lives gracefully (attrition).
//  Remove it once none remain.
//
//  Combatant — the generic warband creep (#39). It has NO hardcoded conduct of
//  its own: its behaviour is entirely COMPOSED from the behavior set declared in
//  creep.memory.behaviors, driven each tick by the per-creep BehaviorMachine.
//
//  This is the model the whole Behavior layer enables — a creep is "body +
//  composable behaviors", re-taskable on the fly (rewrite memory.behaviors via the
//  #174 command interface / set_memory and the conduct changes next tick) rather
//  than frozen to one role. A warband draws its members from the combat catalog
//  (raidRoom / holdPoint / focusFire / healGroup / kiteScreen).
//
//  WarbandOverlord (#174) spawns + drives combatants via the flag-commanded warband;
//  a hand-spawned combatant with a behaviors set also just works (the registry entry
//  makes the layer reachable). The role only carries a combat movement rank — all
//  conduct lives in the behaviors, so no existing role is touched.
// ============================================================================
export class Combatant extends Role {
  // Combat rank, same as Guard — it has somewhere to be and shouldn't be shoved by idlers.
  static movementPriority = 3;

  static run(creep, colony) {
    BehaviorMachine.run(creep, colony);
  }
}
