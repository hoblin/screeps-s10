import { Behavior } from "../Behavior.js";

const STRAY = 3; // a held creep may stray this far past its spread radius to strike a target, then returns

// ============================================================================
//  HoldPosition — PIN the squad to a fixed point and deny the area around it. Members
//  fan out in a RADIUS around the point (the radius grows with the group size so they
//  don't fight over one tile), engage the NEAREST hostile that enters the zone
//  (lure-proof — never chase the bait out), may STRAY a short distance to strike, then
//  RETURN to the held ground. The commander pins the warband to coordinates (the flag /
//  memory.point) to garrison a chokepoint or kill-zone without drifting off it — unlike
//  raidRoom/holdPoint, it holds the GROUND it's told to, not the controller (#184).
//
//  Pin = memory.point (the flag tile). Body-agnostic: melee closes, ranged shoots.
// ============================================================================
export class HoldPosition extends Behavior {
  static run(creep, _colony) {
    const mode = this.ensureCombatMode(creep);
    const point = this.holdPos(creep);
    if (!point) return; // unpinned → nothing to hold
    if (creep.room.name !== point.roomName) {
      this.note(creep, "hold:to-room");
      creep.travelTo(point, { range: 1 });
      return;
    }

    const radius = this.spreadRadius(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const target = hostiles.length ? creep.pos.findClosestByRange(hostiles) : null;
    // Engage only a target INSIDE the defended zone (radius + a short stray) — a kiting harasser that
    // darts beyond it is left alone, so the pin can't be lured off its ground.
    if (target && target.pos.getRangeTo(point) <= radius + STRAY) {
      if (mode === "melee") {
        this.note(creep, "hold:melee");
        if (creep.pos.isNearTo(target)) creep.attack(target);
        else creep.travelTo(target, { range: 1 });
      } else {
        this.note(creep, "hold:ranged");
        const range = creep.pos.getRangeTo(target);
        if (range <= 3) creep.rangedAttack(target);
        else creep.travelTo(target, { range: 3 });
      }
      return;
    }
    // No in-zone target → settle anywhere within the spread radius (don't contend the exact centre),
    // pulling back if a strike carried us out past it.
    if (creep.pos.getRangeTo(point) > radius) {
      this.note(creep, "hold:to-post");
      creep.travelTo(point, { range: radius });
    } else {
      this.note(creep, "hold:hold");
    }
  }

  // The hold radius grows with how many squadmates share this room, so N members spread over the zone
  // instead of fighting for one tile. ceil(sqrt(N)): 1→1, 2-4→2, 5-9→3 (incl. self).
  static spreadRadius(creep) {
    const here = this.warbandMates(creep).filter((c) => c.room.name === creep.room.name).length + 1;
    return Math.max(1, Math.ceil(Math.sqrt(here)));
  }

  static holdPos(creep) {
    const p = creep.memory.point;
    return p ? new RoomPosition(p.x, p.y, p.roomName) : null;
  }
}
