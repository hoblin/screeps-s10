import { CombatBehaviour } from "./CombatBehaviour.js";
import { shoot, meleeStrike, holdAnchor } from "./atoms/acts.js";
import { nearestHostile } from "./atoms/selectors.js";
import { routeToRoom } from "../../lib/Transit.js";

const HOLD_ZONE = 6; // only hostiles within this of the held point influence the unit — a lure darting
// beyond it is ignored, so a distant enemy can't pull the pin off its ground (lure-proof).

// ============================================================================
//  HoldPosition — PIN a unit to a point and deny the area. It garrisons the ground (#184): fires anything
//  that enters the hold zone WITHOUT chasing it, and returns to the post if knocked off — the position,
//  not a pursuit, sets the feet, so a lure can't drag it away. Body-agnostic: ranged shoots (mass-blast in
//  a crowd), melee strikes an adjacent intruder.
//
//  Pin = memory.point (the flag). A denial pin HOLDS its tile and out-heals — it does not give ground or
//  kite (that's the mobile conduct's job); reach off the magnet field (#190) was retired in #280 in favour
//  of this simpler stand-and-fire hold.
// ============================================================================
export class HoldPosition extends CombatBehaviour {
  static run(creep, _colony) {
    const point = this.holdPos(creep);
    if (!point) return false; // unpinned → nothing to hold
    if (creep.room.name !== point.roomName) {
      // Danger-aware, swamp-aware transit to the theatre (#197/#230 — route around what we can't beat). No
      // safe corridor → hold here rather than walk blind into a tower/unwinnable room.
      if (routeToRoom(creep, point.roomName, { allowUnscouted: false, clearer: creep })) this.note(creep, "hold:to-room");
      else this.note(creep, "hold:blocked");
      return true;
    }

    // Only point-local hostiles count — distant ones can't lure the pin off its ground.
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS).filter((h) => h.pos.getRangeTo(point) <= HOLD_ZONE);
    const melee = creep.getActiveBodyparts(ATTACK) > 0;
    const target = hostiles.length ? nearestHostile(creep, hostiles) : null;

    // Attack without chasing (fires whatever the feet do this tick): ranged shoots anything in reach; melee
    // strikes only an adjacent intruder. The position (below), not a pursuit, sets the feet.
    if (target && !melee) {
      this.note(creep, "hold:ranged");
      shoot(creep, target, hostiles.length > 1);
    } else if (target && meleeStrike(creep, target)) {
      this.note(creep, "hold:melee");
    }

    // Hold the GROUND: settle within a tile of the post (range 1 so several holders don't fight for the
    // exact tile) and return to it if knocked off — a denial pin holds, it does not kite away.
    if (holdAnchor(creep, point, 1)) {
      if (!target) this.note(creep, "hold:to-post");
    } else if (!target) {
      this.note(creep, "hold:hold");
    }
    return true;
  }

  static holdPos(creep) {
    const p = creep.memory.point;
    return p ? new RoomPosition(p.x, p.y, p.roomName) : null;
  }
}
