import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  Reserver — a CLAIM creep that keeps an adjacent remote room reserved.
//
//  Reserving (NOT claiming — zero GCL cost) boosts a room's sources from
//  1500/300 to 3000/300, doubling a remote's yield. The reserver travels to the
//  target room's controller (multi-room via travelTo, #92) and calls
//  reserveController each tick; one CLAIM holds the reservation active, which is
//  all a source needs to stay at the full 3000/300.
//
//  The target room + controller tile are stamped by the ReserveOverlord at spawn
//  (from the static expansion map, #88; one reserver per remote room, #102). That
//  map already excluded Source-Keeper and enemy rooms; the LIVE safety the map can't
//  give comes from the shared threat intel — if the room turns hot (#105) the
//  reserver retreats home rather than feed itself to an invader, and returns once it
//  cools (the map is a stale prior; volatile danger lives in Threat.isHot).
// ============================================================================
export class Reserver extends Role {
  // Lowest movement priority of any role: a reserver isn't economy-critical and
  // spends its life parked on a foreign controller — it must yield to home
  // traffic, never shove it. (miner 1, haul 2, work/upgrade 3, base 4 → reserver 5.)
  static movementPriority = 5;

  // CLAIM is expensive (600); one CLAIM holds a reservation steady (source stays
  // at 3000/300), a second builds a decay buffer. Scale with the spawn budget.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([CLAIM, MOVE], { extra: [CLAIM, MOVE], max: 1, energy: energyBudget });
  }

  static run(creep, colony) {
    // This reserver is bound to ONE room, stamped at spawn (#102) — with many remotes
    // it can't read "the" target live. Its per-room overlord stops spawning while the
    // room is hot (desiredCount→0); an already-out reserver retreats here, reading the
    // SHARED threat intel (Threat.isHot, #105) — not a per-tick local hostile scan
    // (which used to flee a harmless scout). It cools → the reserver returns.
    const target = creep.memory.reserveRoom;
    if (!target) {
      this.note(creep, "reserve:no-target");
      return this.retreatHome(creep, colony);
    }
    const { room: targetRoom, controller: cp } = target;

    if (Threat.isHot(targetRoom)) {
      this.note(creep, "reserve:hot");
      return this.retreatHome(creep, colony);
    }

    // Not there yet → cross-room travel. travelTo's foreign-room branch (#92)
    // delegates the inter-room leg to the engine's moveTo, then resumes in-room.
    if (creep.room.name !== targetRoom) {
      if (!cp) return this.retreatHome(creep, colony); // map entry has no controller tile
      this.note(creep, "reserve:to-room");
      creep.travelTo(new RoomPosition(cp.x, cp.y, targetRoom), { range: 1 });
      return;
    }

    const controller = creep.room.controller;
    if (!controller) return this.retreatHome(creep, colony); // map only targets rooms with a controller
    const result = creep.reserveController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      this.note(creep, "reserve:approach");
      creep.travelTo(controller, { range: 1 });
    } else if (result === OK) {
      this.note(creep, "reserve:hold");
    } else {
      // Controller became owned/invalid since the map was generated (e.g. someone
      // claimed it), or we lack a CLAIM part — don't spam reserveController forever;
      // pull home so the overlord can re-target when the map next updates.
      this.retreatHome(creep, colony);
    }
  }

  // Pull back out of the hostile room and idle near home until it's safe again.
  static retreatHome(creep, colony) {
    const anchor = colony.spawns[0] || colony.controller;
    if (anchor) creep.travelTo(anchor, { range: 3 });
  }
}
