import { Role } from "./Role.js";
import { Engage } from "../behaviors/combat/Engage.js";
import { combatBody } from "../lib/CombatBody.js";

const GUARD_PARK_DELAY = 5; // ticks to hold the spot after the last hostile contact before walking
// back to park — long enough to shoot a harasser that ducks across the border and returns (#160).

// ============================================================================
//  Guard — the colony's combat creep: clears a contested remote so the economy
//  can flow back (#118, Levels 2-3 of the threat ladder).
//
//  A dumb executor (per the domain-controller doctrine): GuardOverlord decides
//  WHICH hot room is winnable and stamps it (+ the body TYPE) at spawn; this role
//  travels there, kills the armed threat, mops up the harmless stragglers (scouts /
//  reservers), then GARRISONS the room — parks on its controller and holds for life,
//  re-engaging anything that wanders in (#128). After a fight it holds the spot a few ticks
//  before walking back to park, so a harasser that ducks across the border and returns is shot
//  on the spot rather than re-chased from the controller (#160). It never recycles on clear (a
//  stationed guard answers the next poke with no rebuild and keeps the room's intel
//  fresh via vision); only the overlord releasing it (room left the footprint) sends
//  it home. Bailing on a false alarm happens only in transit (room cooled en route).
//
//  Retaliation (#140): once its room cools, the OVERLORD may redirect this idle guard to deny the
//  attacker's tower-free remote — it stamps the enemy room as `guardRoom` + a `retaliationMission`.
//  The guard then travels and engages/holds there exactly as it garrisons home, denying his economy
//  (the in-transit empty-bail is suppressed for the mission). The combat itself is the shared
//  `Engage` behavior atom (#189) — it remembers the armed attacker's owner as `creep.memory.foughtOwner`;
//  Guard.run keeps only the role orchestration (transit, garrison #128, post-clear hold #160).
//
//  Type is rock-paper-scissors to the enemy profile (chosen by the overlord):
//   • "ranged" — RANGED_ATTACK + HEAL + MOVE: kites melee (they can't reach us) and
//     out-sustains a ranged mirror. The robust counter to any MOBILE threat.
//   • "melee"  — ATTACK + MOVE: cheap burst for a threat that can't kite back
//     (an invader core / structure). Higher DPS-per-energy when kiting isn't needed.
// ============================================================================
export class Guard extends Role {
  // Above idle/work roles but below the core haul/mine economy: a guard mostly lives
  // in a remote room, so it rarely contends home traffic, but it still has somewhere
  // to be — it shouldn't be shoved aside by an idle worker.
  static movementPriority = 3;

  // The guard's body — its own role body, sized by the shared combat sizer (#189).
  static bodyFor(energyBudget, profile) {
    return combatBody(energyBudget, profile);
  }

  static run(creep, colony) {
    const room = creep.memory.guardRoom;
    if (!room) return this.recycleAtHome(creep, colony); // released (off-map) → recycle

    // In transit: bail only if we can SEE the room is truly empty (no hostiles at
    // all) — a confirmed false alarm. We do NOT bail on !isHot: isHot is lethal-only,
    // so it drops the moment the armed threat dies while a reserver/scout still needs
    // mopping; and we never bail blind (no vision → trust the dispatch, keep going).
    // The on-arrival scan below then decides mop / park / (nothing to do →) garrison.
    if (creep.room.name !== room) {
      // Bail on a confirmed-empty room in transit — but NOT on a retaliation mission (#140): a
      // momentarily-empty enemy remote isn't a false alarm, it's the target; the overlord owns
      // when that mission ends (recall / tower / he left).
      const seen = Game.rooms[room];
      if (seen && !creep.memory.retaliationMission && seen.find(FIND_HOSTILE_CREEPS).length === 0) {
        creep.memory.guardRoom = null;
        return this.recycleAtHome(creep, colony);
      }
      // En-route on a retaliation mission (#140): if the locked offender's creeps are in THIS room,
      // fight them; else travel on. A mobile guard hunting the owner along the route — the jumper
      // can't shake it the way it escapes a garrison — but it never DIVERTS off-route to chase (the
      // route through his territory does the following), so it still reaches the remote to deny it.
      if (creep.memory.retaliationMission && Engage.run(creep, colony, { ownerFilter: creep.memory.foughtOwner })) {
        creep.memory.lastEngaged = Game.time;
        return;
      }
      this.note(creep, "guard:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return;
    }

    // On station. Fight any hostiles (armed first, then mop harmless stragglers); once the
    // room is clean, garrison the controller and hold for life.
    if (Engage.run(creep, colony)) {
      creep.memory.lastEngaged = Game.time; // mark contact for the post-clear hold (#160)
      return;
    }
    // Just cleared: hold the spot for a few ticks before walking back to park (#160), so a
    // harasser that ducked across the border and returns is shot from here instead of re-chased
    // from the controller (the old controller↔border oscillation). A retask/recall exits earlier
    // — it trips the in-transit branch above before this is reached.
    if (this.holding(creep)) {
      this.note(creep, "guard:hold");
      return;
    }
    const ctrl = creep.room.controller;
    if (ctrl && !creep.pos.inRangeTo(ctrl, 1)) {
      this.note(creep, "guard:to-post");
      creep.travelTo(ctrl, { range: 1 });
    } else {
      // Garrison: defend the controller, deny reservers, keep intel fresh. On a retaliation
      // mission (#140) the "controller" is the ATTACKER's — parking there denies HIS remote.
      this.note(creep, creep.memory.retaliationMission ? "guard:deny" : "guard:park");
    }
  }

  // Within the post-engagement hold window (#160): true for the GUARD_PARK_DELAY clear ticks after
  // the last hostile contact. `<=` (not `<`) so a delay of 5 yields a full 5 clear ticks of hold —
  // `lastEngaged` is the LAST contact tick, and the first clear tick is already `now - last == 1`.
  // Keyed off that contact tick (stamped on engage), so it expires on its own and is never
  // refreshed on clear ticks; a never-engaged guard (no lastEngaged) skips the hold and parks
  // immediately on arrival.
  static holding(creep) {
    const last = creep.memory.lastEngaged;
    return last !== undefined && Game.time - last <= GUARD_PARK_DELAY;
  }
}
