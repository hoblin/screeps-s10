import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  Upgrader — keeps the room controller leveling, now a THIN STATE MACHINE (#251) like the combat
//  roles and Worker (#239). No procedural conduct of its own: the park-and-pump behaviour (the
//  gather↔upgrade cycle ⊕ the controller-FEED gather ladder) lives in the `upgradeController` economy
//  behaviour, driven each tick by the per-creep BehaviorMachine. The UpgradeOverlord owns the count
//  and the controller-container planning; the behaviour only executes conduct.
// ============================================================================
export class Upgrader extends Role {
  // Controller progress yields to logistics: an upgrader parked by the controller container must
  // step aside so the hauler can deliver to it.
  static movementPriority = 3;

  // The role's conduct set — one node, no edges. The UpgradeOverlord stamps this at spawn.
  static behaviors = { default: "upgradeController" };

  static run(creep, colony) {
    // Self-heal the behaviour set for upgraders that predate the #251 lift (no memory.behaviors).
    if (!creep.memory.behaviors) creep.memory.behaviors = Upgrader.behaviors;
    BehaviorMachine.run(creep, colony);
  }
}
