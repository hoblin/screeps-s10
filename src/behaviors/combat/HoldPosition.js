import { Behavior } from "../Behavior.js";
import { shoot, meleeHit, closeTo, holdAnchor } from "./atoms/acts.js";
import { nearestHostile } from "./atoms/selectors.js";
import { KITE_RANGE } from "../../lib/Movement.js";

const STRAY = 3; // a held creep may stray this far past its spread radius to strike, then returns

// ============================================================================
//  HoldPosition — PIN the squad to a fixed point and deny the area around it. Members fan
//  out in a RADIUS that grows with group size (so they don't fight over one tile), engage
//  the NEAREST hostile that enters the zone (lure-proof — never chase the bait out), may
//  STRAY a short way to strike, then RETURN. Unlike raidRoom/holdPoint it holds the GROUND
//  it's told to, not the controller (#184). Ranged holds its ground (no kite-back).
//
//  Pin = memory.point (the flag). Body-agnostic.
// ============================================================================
export class HoldPosition extends Behavior {
  static run(creep, _colony) {
    const point = this.holdPos(creep);
    if (!point) return false; // unpinned → nothing to hold
    if (creep.room.name !== point.roomName) {
      this.note(creep, "hold:to-room");
      creep.travelTo(point, { range: 1 });
      return true;
    }

    const radius = this.spreadRadius(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const target = hostiles.length ? nearestHostile(creep, hostiles) : null;
    // Engage only a target INSIDE the defended zone (radius + a short stray) — a kiting
    // harasser darting beyond it is left alone, so the pin can't be lured off its ground.
    if (target && target.pos.getRangeTo(point) <= radius + STRAY) {
      if (creep.getActiveBodyparts(ATTACK) > 0) {
        this.note(creep, "hold:melee");
        meleeHit(creep, target);
      } else {
        this.note(creep, "hold:ranged");
        shoot(creep, target);
        if (creep.pos.getRangeTo(target) > KITE_RANGE) closeTo(creep, target, KITE_RANGE);
      }
      return true;
    }
    // No in-zone target → settle anywhere within the spread radius, pulling back if a strike carried us out.
    if (holdAnchor(creep, point, radius)) this.note(creep, "hold:to-post");
    else this.note(creep, "hold:hold");
    return true;
  }

  // The hold radius grows with how many squadmates share this room, so N members spread over
  // the zone instead of fighting for one tile. ceil(sqrt(N)): 1→1, 2-4→2, 5-9→3 (incl. self).
  static spreadRadius(creep) {
    const here = this.warbandMates(creep).filter((c) => c.room.name === creep.room.name).length + 1;
    return Math.max(1, Math.ceil(Math.sqrt(here)));
  }

  static holdPos(creep) {
    const p = creep.memory.point;
    return p ? new RoomPosition(p.x, p.y, p.roomName) : null;
  }
}
