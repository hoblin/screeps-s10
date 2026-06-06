import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { strike, holdAnchor, travelToRoom } from "./atoms/acts.js";
import { priorityTarget } from "./atoms/selectors.js";

// ============================================================================
//  RaidRoom — the OFFENCE archetype: travel to memory.target room (hunting
//  memory.targetOwner's creeps en route, the #140 pattern), then DENY/RAZE it by a single
//  priority pick (#199): armed creep → spawn → economy creep → other structures by value.
//  A creep target gets full field combat (Engage — kite/dodge/heal); a structure gets closed
//  on and attacked (raze — it doesn't fire back). Spawn outranks harmless creeps so an
//  eliminator kills production instead of chasing respawns. Once the room is fully clear it
//  garrisons the controller. Walls/ramparts are NOT razed (a RANGED body can't — needs a
//  dismantler, #178). Composed from shared atoms; no dependency on the Guard role.
//
//  Doubles as a machine OVERRIDE node for the RETALIATION case (#140/#187): with an attacker locked
//  (memory.targetOwner), a released guard ENTERS this to deny HIS remote — razing his economy is worth
//  far more than recycling. Exits when the lock clears (back to the defend default / freeHunter).
//
//  Assignment: memory.target (room to deny, required), memory.targetOwner (jumper-lock / retaliation, optional).
// ============================================================================
export class RaidRoom extends Behavior {
  // Edge (when used as a node, e.g. the guard machine): enter on a locked attacker, exit when it clears.
  static enteredWhen(creep, _colony) {
    return !!creep.memory.target && !!creep.memory.targetOwner;
  }
  static exitWhen(creep, _colony) {
    return !creep.memory.targetOwner;
  }

  static run(creep, colony) {
    const room = creep.memory.target;
    if (!room) return false; // unassigned → nothing to raid

    if (creep.room.name !== room) {
      // En route: fight the locked owner's creeps if they're in THIS room (hunt the jumper
      // along the corridor); otherwise press on. We never divert off-route to chase (#140).
      const owner = creep.memory.targetOwner;
      if (owner && Engage.run(creep, colony, { ownerFilter: owner })) return true;
      // Danger-aware transit (#197): route around hot/towered rooms instead of walking blind into them.
      if (travelToRoom(creep, room)) {
        this.note(creep, "raid:to-room");
        return true;
      }
      // No safe corridor — fight what's here, else hold; never suicide through a tower to reach the target.
      this.note(creep, "raid:blocked");
      return Engage.run(creep, colony);
    }

    // On target: the single priority pick (armed creep → spawn → economy creep → structure-by-value).
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const pick = priorityTarget(creep, hostiles);
    if (pick instanceof Creep) return !!Engage.run(creep, colony, { threats: hostiles }); // creep → field combat
    if (pick) {
      // A structure (spawn / extensions / storage / …) → close to reach and attack it. We don't kite
      // here: a spawn/economy structure can't shoot back, and a TOWER (which can) is a dismantler's job
      // (#178), not this RANGED raider's. `strike` is the shared close-and-attack-by-body act (self-heals).
      this.note(creep, "raid:raze");
      strike(creep, pick);
      return true;
    }

    // Room fully clear → garrison the controller to deny it.
    const ctrl = creep.room.controller;
    if (ctrl && holdAnchor(creep, ctrl, 1)) this.note(creep, "raid:to-post");
    else this.note(creep, "raid:deny");
    return true;
  }
}
