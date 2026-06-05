import { Behavior } from "../Behavior.js";
import { Guard } from "../../roles/Guard.js";

// ============================================================================
//  RaidRoom — the OFFENCE archetype: travel to memory.target room, hunting
//  memory.targetOwner's creeps en route (so a border-jumper can't shake us by
//  ducking across the line), then DENY the room — engage everything, then hold on
//  its controller. The design reference is the #140 Guard sunk-asset retaliation
//  (manageRetaliation + Guard.run's transit branch), authored fresh here as a
//  composable behavior so the Guard stays untouched. Reuses Guard.engage as the
//  combat nucleus (melee/ranged by body, via ensureCombatMode).
//
//  Assignment (set by the #174 command interface):
//   • memory.target      — the room to deny (required)
//   • memory.targetOwner — username to hunt en route (optional; the jumper-lock)
// ============================================================================
export class RaidRoom extends Behavior {
  static run(creep, colony) {
    this.ensureCombatMode(creep);
    const room = creep.memory.target;
    if (!room) return; // unassigned → nothing to raid

    if (creep.room.name !== room) {
      // En route: if the locked owner's creeps are in THIS room, fight them (hunt the
      // jumper along the corridor); otherwise press on to the target. We never DIVERT
      // off-route to chase — the route through his territory does the following (#140).
      const owner = creep.memory.targetOwner;
      if (owner && Guard.engage(creep, owner)) return;
      this.note(creep, "raid:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return;
    }

    // On target: engage all hostiles; once clear, garrison the controller to deny it.
    if (Guard.engage(creep)) return;
    const ctrl = creep.room.controller;
    if (ctrl && !creep.pos.inRangeTo(ctrl, 1)) {
      this.note(creep, "raid:to-post");
      creep.travelTo(ctrl, { range: 1 });
    } else {
      this.note(creep, "raid:deny");
    }
  }
}
