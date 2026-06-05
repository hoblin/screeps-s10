import { Behavior } from "../Behavior.js";
import { Guard } from "../../roles/Guard.js";

// ============================================================================
//  HoldPoint — the DEFENCE archetype: garrison an assigned spot and keep it
//  clear. Travel to the hold point, engage any hostile that comes (reusing
//  Guard.engage), and hold on the point otherwise. The standing counterpart to
//  RaidRoom — a positional defender for a room/tile we want to deny the enemy.
//
//  Assignment (set by the #174 command interface):
//   • memory.point  — { x, y, roomName } exact tile to hold (preferred), OR
//   • memory.target — a room name (falls back to its centre, range 1)
// ============================================================================
export class HoldPoint extends Behavior {
  static run(creep, colony) {
    this.ensureCombatMode(creep);
    const point = this.holdPos(creep);
    if (!point) return; // unassigned → nothing to hold

    if (creep.room.name !== point.roomName) {
      this.note(creep, "hold:to-room");
      creep.travelTo(point, { range: 1 });
      return;
    }
    if (Guard.engage(creep)) return; // intruder → fight it
    if (!creep.pos.inRangeTo(point, 1)) {
      this.note(creep, "hold:to-post");
      creep.travelTo(point, { range: 1 });
    } else {
      this.note(creep, "hold:hold");
    }
  }

  // The tile to hold: an explicit point, else the centre of the assigned room.
  static holdPos(creep) {
    const p = creep.memory.point;
    if (p) return new RoomPosition(p.x, p.y, p.roomName);
    const room = creep.memory.target;
    return room ? new RoomPosition(25, 25, room) : null;
  }
}
