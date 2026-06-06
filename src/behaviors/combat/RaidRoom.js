import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { strike, holdAnchor } from "./atoms/acts.js";
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
//  Assignment: memory.target (room to deny, required), memory.targetOwner (jumper-lock, optional).
// ============================================================================
export class RaidRoom extends Behavior {
  static run(creep, colony) {
    const room = creep.memory.target;
    if (!room) return false; // unassigned → nothing to raid

    if (creep.room.name !== room) {
      // En route: fight the locked owner's creeps if they're in THIS room (hunt the jumper
      // along the corridor); otherwise press on. We never divert off-route to chase (#140).
      const owner = creep.memory.targetOwner;
      if (owner && Engage.run(creep, colony, { ownerFilter: owner })) return true;
      this.note(creep, "raid:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return true;
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
