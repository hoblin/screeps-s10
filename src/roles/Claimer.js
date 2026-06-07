import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { routeToRoom } from "../lib/Transit.js";

// ============================================================================
//  Claimer — a CLAIM creep that takes a designated 2nd-colony room (#220).
//
//  The first half of the expansion directive: travel SK-safe to the target room
//  (routeToRoom — the scout's plan-once-and-walk transit, #225: a committed
//  tower/keeper-free corridor walked leg-by-leg, no per-tick re-route to yo-yo on,
//  and a scoutThreat bump on damage so the ScoutOverlord hunter clears any persistent
//  blocker) and claimController it. One claim flips controller.my; the Kernel then
//  discovers the room as a Colony on its own and the pioneer bootstrap takes over.
//
//  The target room + controller tile are stamped by ClaimOverlord at spawn from the
//  armed expansion target. The role is a dumb executor: it does NOT pick where to
//  expand (an offline + human decision) — it drives the one creep to the one
//  controller it was handed.
// ============================================================================
export class Claimer extends Role {
  // Yields to home traffic like the reserver — it spends its life in transit and on
  // a foreign controller, never on the home critical path.
  static movementPriority = 5;

  // Route around hostile ranged kill-zones in-room (#145) — routeToRoom keeps it off
  // towered/keeper rooms; avoidHostiles skirts a live kill-zone within a room it does cross.
  static avoidHostiles = true;

  // One CLAIM claims a controller — extra CLAIM buys nothing (claimController needs a
  // single CLAIM part), so the rest of the budget goes to MOVE to drag the heavy CLAIM
  // (fatigue 1/part) across the long, mostly off-road haul to the target.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([CLAIM, MOVE], { extra: [MOVE], max: 3, energy: energyBudget });
  }

  static run(creep, colony) {
    const target = creep.memory.claimRoom;
    if (!target) {
      // No assignment (orphaned by a deploy / the target was cleared) — recycle
      // rather than idle to death.
      return this.recycleAtHome(creep, colony);
    }
    const { room: targetRoom, controller: cp } = target;

    if (creep.room.name !== targetRoom) {
      // Scout-style transit (#225): walk the committed tower/keeper-free corridor leg-by-leg
      // (no per-tick re-route to yo-yo on) and bump scoutThreat on damage so the hunter clears
      // a real blocker. routeToRoom returns false only when no tower-free corridor exists.
      this.note(creep, "claim:to-room");
      if (!routeToRoom(creep, targetRoom)) {
        this.note(creep, "claim:no-route"); // trapped — hold, intel may reopen a path
      }
      return;
    }

    const controller = creep.room.controller;
    if (!controller || controller.my) {
      // Already ours (the claim landed, or a sibling beat us to it) — mission done.
      this.note(creep, "claim:done");
      return;
    }
    const result = creep.claimController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      this.note(creep, "claim:approach");
      creep.travelTo(cp ? new RoomPosition(cp.x, cp.y, targetRoom) : controller, { range: 1 });
    } else if (result === OK) {
      this.note(creep, "claim:claimed");
    } else {
      // ERR_GCL_NOT_ENOUGH / enemy-owned / reserved — ClaimOverlord gates these, so a
      // persistent failure means the target turned unclaimable; hold rather than spam.
      this.note(creep, "claim:blocked");
    }
  }
}
