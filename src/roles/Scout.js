import { Role } from "./Role.js";

// ============================================================================
//  Scout — roams the map to keep room intel fresh (#142).
//
//  Pure vision-delivery: the scout just walks its overlord-assigned route; the
//  Kernel's per-room `Threat.observe` pass records everything it sees (owner,
//  towers, score structures, threat) the moment it has vision of a room. So the
//  scout itself records nothing — it only DELIVERS vision to stale rooms and
//  advances along its route.
//
//  The route + claim live in the overlord's registry (Memory.colonyData[c].
//  scoutRoutes), the single source of truth — the scout reads its own entry by
//  name and advances the index on arrival; ScoutOverlord plans/prunes it.
//
//  Combat is REACTIVE ONLY: the scout ignores every creep and stays on mission,
//  firing back just when it's actually hit — enough to deter the cheap
//  1×RANGED+1×MOVE harassers that farm scouts for free, without provoking or
//  chasing. If it dies anyway, its route tail auto-frees (claim-by-liveness).
// ============================================================================
export class Scout extends Role {
  // Lowest priority — a non-essential roamer yields its tile to everyone.
  static movementPriority = 8;

  // One RANGED_ATTACK for cheap self-defence (we're energy-rich; matches the rival
  // meta) + one MOVE to carry it. The ranged part adds swamp fatigue (slower on swamp
  // than a pure [MOVE]) but is free on roads/plains; only loosens the route-length cap.
  static bodyFor(_energyBudget) {
    return [RANGED_ATTACK, MOVE];
  }

  static run(creep, colony) {
    this.retaliate(creep); // reactive self-defence; never diverts from the route

    const plan = Memory.colonyData?.[colony.name]?.scoutRoutes?.[creep.name];
    if (!plan || !plan.route || plan.index >= plan.route.length) {
      // No route, or finished — the overlord re-plans on its run() this tick.
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

  // Fire back only when actually damaged this tick (hits dropped since last seen). Never
  // chases or steps off-route — just punishes an attacker already in range, then records
  // this tick's hits for next time.
  static retaliate(creep) {
    const previous = creep.memory.lastHits ?? creep.hitsMax;
    if (creep.hits < previous) {
      const attacker = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (attacker && creep.pos.getRangeTo(attacker) <= 3) creep.rangedAttack(attacker);
    }
    creep.memory.lastHits = creep.hits;
  }
}
