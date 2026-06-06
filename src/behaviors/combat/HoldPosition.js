import { Behavior } from "../Behavior.js";
import { shoot, meleeStrike } from "./atoms/acts.js";
import { nearestHostile } from "./atoms/selectors.js";
import { steer, enemyField, separation, attract, PRIORITY_HOLD, APPROACH_RANGE } from "./atoms/field.js";

const HOLD_ZONE = 6; // only hostiles within this of the held point influence the squad — a lure darting
// beyond it is ignored, so a distant enemy's wide attract can't pull the pin off its ground (lure-proof).

// ============================================================================
//  HoldPosition (#190 flagship) — PIN the squad to a point and deny the area, on the
//  magnet field. Positioning is the SUM of three magnets: a WEAK pull to the held point
//  (attract), the enemy field under the HOLD priority (offence repels at kite range,
//  healers/armed lean it onto the priority kill), and SEPARATION from squadmates (≥3 so
//  one rangedMassAttack can't catch two). It shoots the nearest hostile while the field
//  keeps it spread and out of stacked fire — holding the GROUND (#184) without standing
//  in the AOE that wiped the old ceil(sqrt(N)) pin (#185).
//
//  Pin = memory.point (the flag). Body-agnostic: ranged shoots + field-dances; melee
//  strikes an adjacent intruder and the field holds it on the tile.
// ============================================================================
export class HoldPosition extends Behavior {
  static run(creep, _colony) {
    const point = this.holdPos(creep);
    if (!point) return false; // unpinned → nothing to hold
    if (creep.room.name !== point.roomName) {
      this.note(creep, "hold:to-room"); // transit to the theatre on A*; the field takes over in-room
      creep.travelTo(point, { range: 1 });
      return true;
    }

    // Only point-local hostiles count — distant ones can't lure the pin off its ground.
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS).filter((h) => h.pos.getRangeTo(point) <= HOLD_ZONE);
    const melee = creep.getActiveBodyparts(ATTACK) > 0;
    const target = hostiles.length ? nearestHostile(creep, hostiles) : null;

    // Attack without chasing (compound — fires whatever the feet do this tick): ranged shoots anything
    // in reach; melee strikes only an adjacent intruder. Lure-proof — the position (below), not a
    // pursuit, sets the feet.
    if (target && !melee) {
      this.note(creep, "hold:ranged");
      shoot(creep, target, hostiles.length > 1);
    } else if (target && meleeStrike(creep, target)) {
      this.note(creep, "hold:melee"); // strike an adjacent intruder; the field (below) keeps the ground
    }

    // Position: navigate to the held ground by A* while still FAR from it (#196 — paths around walls,
    // prefers roads); the magnet field takes over once on station (weak pull to the point ⊕ dodge/
    // priority off the enemies ⊕ squad spread). Melee body-blockers omit the enemy field (they hold
    // the tile, not kite).
    if (creep.pos.getRangeTo(point) > APPROACH_RANGE) {
      if (!target) this.note(creep, "hold:to-post");
      creep.travelTo(point, { range: 1 });
    } else {
      if (!target) this.note(creep, "hold:hold");
      const magnets = [attract(point), ...separation(creep)];
      if (!melee) magnets.push(...enemyField(hostiles, PRIORITY_HOLD));
      // Field micro on station, with an A* fallback if it freezes while still walled off from the held
      // ground (goalRange ≈ the spread extent, so a creep correctly spread near the point doesn't detour).
      steer(creep, magnets, { goal: point, goalRange: 3 });
    }
    return true;
  }

  static holdPos(creep) {
    const p = creep.memory.point;
    return p ? new RoomPosition(p.x, p.y, p.roomName) : null;
  }
}
