import { Behavior } from "../Behavior.js";
import { shoot } from "./atoms/acts.js";
import { nearestHostile } from "./atoms/selectors.js";
import { steer, enemyField, separation, attract, PRIORITY_HOLD } from "./atoms/field.js";

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

    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const melee = creep.getActiveBodyparts(ATTACK) > 0;
    const target = hostiles.length ? nearestHostile(creep, hostiles) : null;

    // Attack without chasing: ranged fires if anything's in reach (held ground, lure-proof — the
    // field, not a pursuit, sets position); melee strikes only an adjacent intruder.
    if (target && !melee) {
      this.note(creep, "hold:ranged");
      shoot(creep, target, hostiles.length > 1);
    } else if (target && creep.pos.isNearTo(target)) {
      this.note(creep, "hold:melee");
      creep.attack(target);
    } else {
      this.note(creep, "hold:hold");
    }

    // Position by the field: weak pull to the point ⊕ dodge/priority off the enemies ⊕ squad spread.
    // Melee body-blockers omit the enemy field (they hold the tile, not kite).
    const magnets = [attract(point), ...separation(creep)];
    if (!melee) magnets.push(...enemyField(hostiles, PRIORITY_HOLD));
    steer(creep, magnets);
    return true;
  }

  static holdPos(creep) {
    const p = creep.memory.point;
    return p ? new RoomPosition(p.x, p.y, p.roomName) : null;
  }
}
