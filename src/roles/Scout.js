import { Role } from "./Role.js";
import { Threat } from "../lib/Threat.js";

const FLEE_TICKS = 10; // stay in flee mode this long after the LAST hit (hysteresis)

// ============================================================================
//  Scout — roams the map to keep room intel fresh (#142).
//
//  Pure vision-delivery: the scout just walks its overlord-assigned route; the
//  Kernel's per-room `Threat.observe` pass records everything it sees (owner,
//  towers, ground Score objects, threat) the moment it has vision of a room. So the
//  scout itself records nothing about a room's contents — it only DELIVERS vision
//  to stale rooms and advances along its route (the route + claim live in the
//  overlord's registry, Memory.colonyData[c].scoutRoutes — the single source of
//  truth; the scout reads its entry by name and advances the index on arrival).
//
//  THREE MODES:
//   • normal — walk the route, deliver vision (#142).
//   • score  — when the overlord stamps a `scoreDiversion` (a known ground Score within
//     reach, #24), detour to OCCUPY that tile, which banks the points, then resume the
//     route at the same index. Score is collectible from tick 0 — this is the win.
//   • flee   — entered the instant the scout takes damage; it records the room as
//     scout-dangerous (so the planner deprioritises it), ABANDONS its route + any score
//     diversion, and retreats toward HOME (the fixed safe anchor — "back the way it
//     came", which also draws a chaser toward our tower). A defenceless [MOVE] scout
//     can't fight, so surviving to scout elsewhere beats marching deeper in. Hysteresis
//     (FLEE_TICKS after the last hit) lets it escape; once safe, the overlord re-plans a
//     route that avoids the room it fled. (Supersedes #142's retaliate-and-continue.)
// ============================================================================
export class Scout extends Role {
  // Lowest priority — a non-essential roamer yields its tile to everyone.
  static movementPriority = 8;

  // Route around hostile ranged kill-zones (#145) — a scout was one-shot pathing past one.
  static avoidHostiles = true;

  // Pure [MOVE] — SPEED is the win lever (race rivals to a Score tile before it decays,
  // deliver vision faster), and a [MOVE]-only creep takes 1 tile/tick on any terrain (zero
  // fatigue) and costs just 50. Self-defence is covered without a body part by three layers:
  // escort clears persistent blockers (#149), reactive-flee bails on the first hit (#148),
  // and avoidHostiles routes around ranged kill-zones (#145) — so the old lone RANGED_ATTACK
  // (which couldn't win a fight anyway and added swamp fatigue) is dropped.
  static bodyFor(_energyBudget) {
    return [MOVE];
  }

  static run(creep, colony) {
    const plan = Memory.colonyData?.[colony.name]?.scoutRoutes?.[creep.name];
    this.trackRoom(creep, plan); // record where we are (flee target + death attribution)

    if (this.tookDamage(creep)) this.enterFlee(creep, plan);
    creep.memory.lastHits = creep.hits;

    if (this.fleeing(creep)) return this.flee(creep, colony);

    // Score mode (#24): the overlord stamped a known Score in reach — detour to occupy
    // its tile (banks the points). collectScore returns false once banked/gone, so we
    // fall through and resume the route at the same index this very tick.
    if (plan?.scoreDiversion && this.collectScore(creep, plan)) return;

    // Normal mode: walk the assigned route, delivering vision.
    if (!plan || !plan.route || plan.index >= plan.route.length) {
      // No route, or finished/abandoned — the overlord re-plans on its run() this tick.
      this.note(creep, "scout:wait");
      return;
    }
    const target = plan.route[plan.index];
    if (creep.room.name === target) {
      // We're in it → the Kernel observed it this tick; advance to the next leg room.
      plan.index += 1;
      this.note(creep, "scout:reached");
      const next = plan.route[plan.index];
      if (next) creep.travelTo(new RoomPosition(25, 25, next), { range: 20 });
      return;
    }
    this.note(creep, "scout:to-room");
    creep.travelTo(new RoomPosition(25, 25, target), { range: 20 });
  }

  // Stamp the current room into the (overlord-owned) plan, so a death can be attributed to
  // the room it fell in — `creep.memory` is already wiped by the time the overlord prunes,
  // but the plan survives until the prune deletes it.
  static trackRoom(creep, plan) {
    if (plan) plan.lastRoom = creep.room.name;
  }

  // Took damage since last tick (the flee trigger). Defaults to hitsMax so a never-hit
  // scout reads as undamaged.
  static tookDamage(creep) {
    return creep.hits < (creep.memory.lastHits ?? creep.hitsMax);
  }

  // Enter (or refresh) flee mode: record the room as scout-dangerous, refresh the flee
  // window, ABANDON the current route (index → end) so the overlord re-plans a safe one once
  // flee ends — otherwise the scout would walk straight back into the room it fled — and DROP
  // any score diversion (survival outranks a few points; another scout or a later pass grabs
  // it). The threat bump fires only on the TRANSITION into flee, so a sustained attack counts
  // as one episode, not one per tick.
  static enterFlee(creep, plan) {
    if (!this.fleeing(creep)) Threat.bumpScoutThreat(creep.room.name);
    creep.memory.fleeUntil = Game.time + FLEE_TICKS;
    if (plan && plan.route) plan.index = plan.route.length;
    if (plan) delete plan.scoreDiversion;
  }

  static fleeing(creep) {
    return (creep.memory.fleeUntil || 0) > Game.time;
  }

  // Retreat toward HOME — the fixed safe anchor (and tower cover); per-room back-stepping
  // would yo-yo into the very room being fled, so we head for the anchor instead. A pure
  // [MOVE] scout has no shot to fire back — speeding away IS the whole defence.
  static flee(creep, colony) {
    this.note(creep, "scout:flee");
    if (creep.room.name !== colony.name) {
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
    }
  }

  // Score mode (#24): occupy the diverted Score tile to bank its points, then resume.
  // Returns true while still travelling there; false once the points are banked (we're on
  // the tile) or the Score is gone (a rival/decay took it — we can see the room and the tile
  // is empty), having cleared the diversion so run() resumes the route this tick.
  static collectScore(creep, plan) {
    const d = plan.scoreDiversion;
    const tile = new RoomPosition(d.x, d.y, d.room);
    const inRoom = creep.room.name === d.room;
    const gone = inRoom && tile.lookFor(LOOK_SCORE).length === 0;
    if (creep.pos.isEqualTo(tile) || gone) {
      delete plan.scoreDiversion;
      return false;
    }
    this.note(creep, "scout:score");
    creep.travelTo(tile); // range 0 (default) — we must stand ON the tile to bank it
    return true;
  }
}
