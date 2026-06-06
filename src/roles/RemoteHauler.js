import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  RemoteHauler (#204) — a THIN BehaviorMachine role, like Combatant/Hunter. The
//  haul conduct lives in the `remoteHaul` economy behavior (which also owns the body);
//  the RemoteLogisticsOverlord steers the unit by stamping creep.memory.haulTarget (the
//  command pattern). The role keeps only its creep-IDENTITY statics (read off the role
//  class via memory.role):
//    • movementPriority — below home haulers (2), above idle: it moves energy but must
//      never shove the core economy.
//    • avoidHostiles — detour around hostile ranged kill-zones on the long haul (#145).
//    • behaviors — the behavior set this role is born with (the model the overlord stamps).
// ============================================================================
export class RemoteHauler extends Role {
  static movementPriority = 3;
  static avoidHostiles = true;

  // The conduct set: one node, no edges (the gather↔deliver toggle is a linear cycle
  // inside the node, not a preempting override). The overlord stamps this at spawn.
  static behaviors = { default: "remoteHaul" };

  static run(creep, colony) {
    // Self-heal the behavior set for haulers that predate the #204 lift (a live fleet
    // spawned by the old role carries no behaviors stamp) so they aren't left inert.
    if (!creep.memory.behaviors) creep.memory.behaviors = RemoteHauler.behaviors;
    BehaviorMachine.run(creep, colony);
  }
}
