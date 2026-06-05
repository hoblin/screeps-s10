import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
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
//  No overlord spawns combatants yet — the #174 command interface + a WarbandOverlord
//  do that. Registering the role here makes the layer REACHABLE and runnable in the
//  meantime (a hand-spawned combatant with a behaviors set just works), and gives it
//  a combat movement rank, without touching or destabilising any existing role.
// ============================================================================
export class Combatant extends Role {
  // Combat rank, same as Guard — it has somewhere to be and shouldn't be shoved by idlers.
  static movementPriority = 3;

  static run(creep, colony) {
    BehaviorMachine.run(creep, colony);
  }
}
