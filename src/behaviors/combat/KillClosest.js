import { Behavior } from "../Behavior.js";

const LEASH = 5; // anti-lure: never chase a target more than this far from the anchor — a kiting
// harasser baiting us off the room's economy is ignored once it darts beyond the kill-zone.

// ============================================================================
//  KillClosest — area-denial conduct that CANNOT be lured. raidRoom/focusFire (and
//  Guard.engage underneath) target the ARMED hostile first, so a kiting harasser is
//  perfect bait: it drags the squad off the haulers it's screening. This instead
//  attacks the NEAREST hostile of ANY kind and holds an anchor — it kills the
//  haulers/miners that cycle through, chips the harasser only when it comes close, and
//  refuses to pursue it beyond LEASH of the anchor. The commander switches the warband
//  to this LIVE (the memory-driven selector) the moment an enemy starts luring.
//
//  Anchor = memory.point (the flag tile — drop it on the hauler path / source), else
//  the room controller. Body-agnostic: melee closes within leash, ranged shoots + holds.
// ============================================================================
export class KillClosest extends Behavior {
  static run(creep, _colony) {
    const mode = this.ensureCombatMode(creep);
    const anchor = this.anchorPos(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length) {
      const target = creep.pos.findClosestByRange(hostiles);
      const leashed = !anchor || target.pos.getRangeTo(anchor) <= LEASH; // inside the kill-zone?
      if (mode === "melee") {
        this.note(creep, "kc:melee");
        if (creep.pos.isNearTo(target)) {
          creep.attack(target);
          return;
        }
        if (leashed) {
          creep.travelTo(target, { range: 1 });
          return;
        }
      } else {
        this.note(creep, "kc:ranged");
        const range = creep.pos.getRangeTo(target);
        if (range <= 3) {
          creep.rangedAttack(target);
          return; // in range — shoot and HOLD (don't drift after the bait)
        }
        if (leashed) {
          creep.travelTo(target, { range: 3 });
          return;
        }
      }
    }
    // Nothing to kill within leash — return to / hold the anchor, never trailing the bait.
    if (anchor && !creep.pos.inRangeTo(anchor, 1)) {
      this.note(creep, "kc:to-post");
      creep.travelTo(anchor, { range: 1 });
    } else {
      this.note(creep, "kc:hold");
    }
  }

  // The tile to anchor the kill-zone on: the commander's flag point, else the controller.
  static anchorPos(creep) {
    const p = creep.memory.point;
    if (p) return new RoomPosition(p.x, p.y, p.roomName);
    const ctrl = creep.room.controller;
    return ctrl ? ctrl.pos : null;
  }
}
