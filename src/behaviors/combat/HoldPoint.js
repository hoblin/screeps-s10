import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { holdAnchor } from "./atoms/acts.js";

// ============================================================================
//  HoldPoint — the DEFENCE archetype: garrison an assigned spot and keep it clear.
//  Travel to the hold point, engage any intruder (the shared Engage nucleus), hold on
//  the point otherwise. The standing counterpart to RaidRoom.
//
//  Assignment: memory.point ({x,y,roomName}, preferred) OR memory.target (room → centre).
// ============================================================================
export class HoldPoint extends Behavior {
  static run(creep, colony) {
    const point = this.holdPos(creep);
    if (!point) return false; // unassigned → nothing to hold

    if (creep.room.name !== point.roomName) {
      this.note(creep, "hold:to-room");
      creep.travelTo(point, { range: 1 });
      return true;
    }
    if (Engage.run(creep, colony)) return true; // intruder → fight it
    if (holdAnchor(creep, point, 1)) this.note(creep, "hold:to-post");
    else this.note(creep, "hold:hold");
    return true;
  }

  // The tile to hold: an explicit point, else the centre of the assigned room.
  static holdPos(creep) {
    const p = creep.memory.point;
    if (p) return new RoomPosition(p.x, p.y, p.roomName);
    const room = creep.memory.target;
    return room ? new RoomPosition(25, 25, room) : null;
  }
}
