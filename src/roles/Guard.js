import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";
import { combatBody } from "../lib/CombatBody.js";

// ============================================================================
//  LEGACY (#262): GuardOverlord is retired — its reactive-defence + retaliation responsibilities moved to
//  OperationalMilitaryOverlord's mission framework, which spawns the "soldier" role. Nothing spawns "guard"
//  any more; this role is kept only so in-flight guards run out their lives gracefully (attrition). The
//  defence missions reuse this exact behaviour set (DEFENSE_BEHAVIORS in src/missions/Mission.js). Remove
//  this role once no live guards remain.
//
//  Guard — the colony's combat creep: clears a contested room so the economy can flow back
//  (#118, Levels 2-3 of the threat ladder; home defence #122). Like Combatant, it is now a THIN
//  STATE MACHINE — no bespoke conduct of its own. All behaviour is COMPOSED from the behavior set
//  GuardOverlord stamps at spawn and driven each tick by the per-creep BehaviorMachine; the overlord
//  steers it purely by writing memory.target / memory.targetOwner (the WarbandOverlord.command pattern).
//
//  The guard's machine is `{ default: "holdPoint", nodes: ["selfDefense", "raidRoom", "holdGround"] }`:
//   • holdPoint  — DEFAULT: travel to the assigned room (danger-aware) and garrison it, engaging
//                  intruders and holding the controller for life (#128).
//   • selfDefense — en-route survival (#232): while travelling, fight an armed hostile that gets close
//                  enough to hit it, then resume the route. FIRST node = preempts the mission to survive.
//   • holdGround — after a fight, hold the contested ground for a few ticks and re-engage returners
//                  before walking back to the post (#160) — entered on a fresh contact in the room.
//   • raidRoom   — RETALIATION (#140): with an attacker locked (targetOwner), deny HIS remote and STAY,
//                  blocking his mining; razing his economy is worth far more than recycling one body.
//  It never roams (no freeHunter) and never recycles (#197): a guard commits to denying ONE remote and
//  holds it until it dies — its terminal is raidRoom, not a return home.
//
//  Guard is the defence-domain combat role (GuardOverlord owns it by the "guard" role tag — unrelated to
//  the commanded warband's "combatant"). Body TYPE is rock-paper-scissors to the enemy profile, chosen
//  by the overlord (ranged kiter vs cheap melee burst) via bodyFor.
// ============================================================================
export class Guard extends Role {
  // Above idle/work roles but below the core haul/mine economy: a guard mostly lives in a remote room,
  // so it rarely contends home traffic, but it still has somewhere to be — not shoved aside by an idler.
  static movementPriority = 3;

  // The role's behaviour set — the role OWNS its conduct composition (GuardOverlord stamps this into
  // each guard's memory.behaviors at spawn). Default holdPoint (garrison the assigned room), with
  // selfDefense (#232 en-route survival, first = highest priority), raidRoom (retaliation deny) and
  // holdGround (#160 post-combat hold) as conditional override nodes.
  static behaviors = { default: "holdPoint", nodes: ["selfDefense", "raidRoom", "holdGround"] };

  // The guard's body — sized by the shared combat sizer to the threat profile (#189). Used by GuardOverlord.
  static bodyFor(energyBudget, profile) {
    return combatBody(energyBudget, profile);
  }

  static run(creep, colony) {
    BehaviorMachine.run(creep, colony);
  }
}
