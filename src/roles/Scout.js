import { Role } from "./Role.js";
import { Threat } from "../lib/Threat.js";

const FLEE_TICKS = 10; // stay in flee mode this long after the LAST hit (hysteresis)

// ============================================================================
//  Scout — roams the map to keep room intel fresh (#142).
//
//  Pure vision-delivery: the scout just walks its overlord-assigned route; the
//  Kernel's per-room `Threat.observe` pass records everything it sees (owner,
//  towers, score structures, threat) the moment it has vision of a room. So the
//  scout itself records nothing about a room's contents — it only DELIVERS vision
//  to stale rooms and advances along its route (the route + claim live in the
//  overlord's registry, Memory.colonyData[c].scoutRoutes — the single source of
//  truth; the scout reads its entry by name and advances the index on arrival).
//
//  TWO MODES (#147):
//   • normal — walk the route, deliver vision.
//   • flee   — entered the instant the scout takes damage; it records the room as
//     scout-dangerous (so the planner deprioritises it), ABANDONS its route, and
//     retreats toward HOME (the fixed safe anchor — the macro "back the way it came",
//     which also draws a chaser toward our tower) with a free parting ranged shot. A
//     1-RANGED scout can't win, so surviving to scout elsewhere beats marching deeper
//     in. Hysteresis (FLEE_TICKS after the last hit) lets it escape; once safe, the
//     overlord re-plans a route that avoids the room it fled. (Supersedes #142's
//     retaliate-and-continue.)
// ============================================================================
export class Scout extends Role {
  // Lowest priority — a non-essential roamer yields its tile to everyone.
  static movementPriority = 8;

  // Route around hostile ranged kill-zones (#145) — a scout was one-shot pathing past one.
  static avoidHostiles = true;

  // One RANGED_ATTACK for cheap self-defence (we're energy-rich; matches the rival
  // meta) + one MOVE to carry it. The ranged part adds swamp fatigue (slower on swamp
  // than a pure [MOVE]) but is free on roads/plains; only loosens the route-length cap.
  static bodyFor(_energyBudget) {
    return [RANGED_ATTACK, MOVE];
  }

  static run(creep, colony) {
    const plan = Memory.colonyData?.[colony.name]?.scoutRoutes?.[creep.name];
    this.trackRoom(creep, plan); // record where we are (flee target + death attribution)

    if (this.tookDamage(creep)) this.enterFlee(creep, plan);
    creep.memory.lastHits = creep.hits;

    if (this.fleeing(creep)) return this.flee(creep, colony);

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
  // window, and ABANDON the current route (index → end) so the overlord re-plans a safe one
  // once flee ends — otherwise the scout would walk straight back into the room it fled. The
  // threat bump fires only on the TRANSITION into flee, so a sustained attack counts as one
  // episode, not one per tick.
  static enterFlee(creep, plan) {
    if (!this.fleeing(creep)) Threat.bumpScoutThreat(creep.room.name);
    creep.memory.fleeUntil = Game.time + FLEE_TICKS;
    if (plan && plan.route) plan.index = plan.route.length;
  }

  static fleeing(creep) {
    return (creep.memory.fleeUntil || 0) > Game.time;
  }

  // Retreat toward HOME with a free parting shot at the closest armed hostile in range.
  // Home is the fixed safe anchor (and tower cover); per-room back-stepping would yo-yo into
  // the very room being fled, so we head for the anchor instead.
  static flee(creep, colony) {
    this.note(creep, "scout:flee");
    const armed = creep.pos
      .findInRange(FIND_HOSTILE_CREEPS, 3)
      .filter((h) => Threat.combatPower(h) > 0);
    const attacker = creep.pos.findClosestByRange(armed);
    if (attacker) creep.rangedAttack(attacker);

    if (creep.room.name !== colony.name) {
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
    }
  }
}
