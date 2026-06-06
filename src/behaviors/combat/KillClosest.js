import { Behavior } from "../Behavior.js";
import { shoot, closeTo, holdAnchor, meleeStrike } from "./atoms/acts.js";
import { nearestHostile, anchorPoint } from "./atoms/selectors.js";
import { KITE_RANGE } from "../../lib/Movement.js";

const LEASH = 5; // anti-lure: never chase a target more than this far from the anchor — a kiting
// harasser baiting us off the room's economy is ignored once it darts beyond the kill-zone.

// ============================================================================
//  KillClosest — area-denial conduct that CANNOT be lured. Where Engage/FocusFire target
//  the ARMED hostile first (perfect bait for a kiting harasser), this attacks the NEAREST
//  hostile of ANY kind and holds an anchor: it kills the haulers/miners cycling through,
//  chips the harasser only when it comes close, and refuses to pursue beyond LEASH of the
//  anchor. Ranged SHOOTS AND HOLDS (never drifts after the bait). The commander switches a
//  warband to this LIVE the moment an enemy starts luring.
//
//  Anchor = memory.point (the flag), else the controller. Body-agnostic.
// ============================================================================
export class KillClosest extends Behavior {
  static run(creep, _colony) {
    const melee = creep.getActiveBodyparts(ATTACK) > 0;
    const anchor = anchorPoint(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length) {
      const target = nearestHostile(creep, hostiles);
      const leashed = !anchor || target.pos.getRangeTo(anchor) <= LEASH; // inside the kill-zone?
      if (melee) {
        this.note(creep, "kc:melee");
        if (meleeStrike(creep, target)) return true; // adjacent → strike and hold
        if (leashed) {
          closeTo(creep, target, 1);
          return true;
        }
      } else {
        this.note(creep, "kc:ranged");
        if (creep.pos.getRangeTo(target) <= KITE_RANGE) {
          shoot(creep, target);
          return true; // in range — shoot and HOLD (don't drift after the bait)
        }
        if (leashed) {
          closeTo(creep, target, KITE_RANGE);
          return true;
        }
      }
    }
    // Nothing leashed to kill — return to / hold the anchor, never trailing the bait.
    if (anchor && holdAnchor(creep, anchor, 1)) this.note(creep, "kc:to-post");
    else this.note(creep, "kc:hold");
    return true;
  }
}
