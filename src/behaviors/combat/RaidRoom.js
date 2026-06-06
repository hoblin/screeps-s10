import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { holdAnchor } from "./atoms/acts.js";

// ============================================================================
//  RaidRoom — the OFFENCE archetype: travel to memory.target room, hunting
//  memory.targetOwner's creeps en route (so a border-jumper can't shake us by ducking
//  across the line — the #140 retaliation pattern), then DENY the room: engage
//  everything, then garrison its controller. Composed from the shared Engage nucleus
//  (the en-route hunt is Engage with an ownerFilter); no dependency on the Guard role.
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

    // On target: engage all hostiles; once clear, garrison the controller to deny it.
    if (Engage.run(creep, colony)) return true;
    const ctrl = creep.room.controller;
    if (ctrl && holdAnchor(creep, ctrl, 1)) this.note(creep, "raid:to-post");
    else this.note(creep, "raid:deny");
    return true;
  }
}
