import { Overlord } from "./Overlord.js";
import { RoomPlanner } from "../lib/RoomPlanner.js";
import { StructureRealizer } from "../lib/StructureRealizer.js";
import { RoomLog } from "../lib/RoomLog.js";

// ============================================================================
//  DefenseOverlord — owns the colony's Towers: places them and operates them.
//
//  Towers are cheap insurance (STRATEGY.md: "rush the first tower, then relax").
//  Unlike every other overlord this one commands STRUCTURES, not creeps, so it
//  spawns nothing (desiredCount 0) and overrides run() to drive its towers
//  directly instead of iterating assignedCreeps.
//
//  Placement is gated implicitly on RCL: CONTROLLER_STRUCTURES[tower][rcl] is 0
//  below RCL3, so planTowers() is a no-op until the first tower unlocks — no
//  separate stage trigger needed. Haulers already keep towers fuelled (see
//  Hauler.deliver step 2).
//
//  Each tick a tower does ONE thing, in priority order:
//    1. attack the closest hostile,
//    2. else heal the most-damaged friendly creep,
//    3. else (only above a combat reserve) repair the most-worn non-wall
//       structure — idle maintenance that must never leave the tower unable to
//       fight.
// ============================================================================

// Energy each tower keeps untouched by idle repair so it can always open fire on
// a sudden hostile. TOWER_CAPACITY is 1000 and an attack shot costs
// TOWER_ENERGY_COST (10), so a 500 reserve is ~50 shots always in the chamber.
const TOWER_ENERGY_RESERVE = 500;

export class DefenseOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 1 });
  }

  // No creeps carry this role; it exists for identifier/telemetry consistency
  // with the other overlords (Dashboard lists it as tower 0/0).
  get role() {
    return "tower";
  }

  // Towers aren't creeps — this overlord never spawns anything.
  desiredCount() {
    return 0;
  }

  // Drive structures, not creeps: place tower sites, then operate live towers.
  //
  // Target candidates are gathered ONCE per tick and shared across every tower
  // — a full-room search per tower would multiply CPU by the tower count (up to
  // 6 at RCL8) for identical results. Heal/repair targets are room-wide
  // most-damaged picks, so all towers focus the same creep/structure (effects
  // stack, clearing the backlog faster); attack stays per-tower (each fires on
  // its own closest hostile for the least range falloff).
  run() {
    this.planTowers();
    const towers = this.towers();
    const prevEngaged = this.engagedCache; // { id: { hits, owner } } we fired at last tick
    if (towers.length === 0) {
      // No towers fired, so nothing was killed — just clear stale tracking.
      if (Object.keys(prevEngaged).length) this.engagedCache = {};
      return;
    }

    const hostiles = this.room.find(FIND_HOSTILE_CREEPS);
    const wounded = hostiles.length
      ? [] // under attack we never reach the heal branch — skip the scan
      : this.room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax });
    const healTarget = wounded.length > 0 ? this.mostDamaged(wounded) : null;
    // The damaged-structure scan is the priciest, so run it only when no tower
    // will fight or heal this tick (otherwise the repair branch is unreachable).
    const repairTarget =
      hostiles.length === 0 && !healTarget ? this.repairTarget() : null;

    // Collect who each tower actually shot this tick, then log/track edges (#107).
    const attacked = {};
    for (const tower of towers) {
      const target = this.operateTower(tower, hostiles, healTarget, repairTarget);
      if (target) attacked[target.id] = { hits: target.hits, owner: target.owner.username };
    }
    this.engagedCache = this.trackEngagements(prevEngaged, attacked, hostiles, towers.length);
  }

  // Story-log tower combat and return the next-tick engaged set (#107). A hostile we
  // just landed a shot on that we weren't already tracking → "engaged". A tracked
  // hostile that has LEFT THE ROOM (not merely unshot this tick — a tower may run
  // dry) → "killed" if its last hits couldn't have exceeded our towers' max damage,
  // else "fled". The killed/fled split is a heuristic (the API gives no kill signal —
  // a dead and a border-crossed creep both just vanish) bounded by our max damage, so
  // an over-HP creep is never mislabelled a kill. Still-present tracked hostiles carry
  // forward, so a dry-tower tick never fakes a kill on a creep that's still standing.
  trackEngagements(prev, attacked, hostiles, towerCount) {
    const present = new Set(hostiles.map((h) => h.id));
    for (const id in attacked) {
      if (!(id in prev)) {
        const c = attacked[id];
        RoomLog.record(this.room.name, "🗼 engaged", { owner: c.owner, hp: c.hits });
      }
    }
    const maxDamage = towerCount * TOWER_POWER_ATTACK;
    for (const id in prev) {
      if (present.has(id)) continue; // still here — not killed/fled, just maybe unshot
      const c = prev[id];
      if (c.hits <= maxDamage) RoomLog.record(this.room.name, "💀 killed", { owner: c.owner });
      else RoomLog.record(this.room.name, "🏃 fled", { owner: c.owner, hp: c.hits });
    }
    // Next-tick set: every engaged hostile still in the room — fresh hits if shot this
    // tick, else carried — so a dry tower doesn't drop a live target and fake a kill.
    const next = {};
    for (const h of hostiles) {
      if (h.id in attacked) next[h.id] = attacked[h.id];
      else if (h.id in prev) next[h.id] = prev[h.id];
    }
    return next;
  }

  // Cross-tick set of hostiles our towers fired at last tick (the overlord is
  // rebuilt each tick, so this lives in Memory) — mirrors MiningOverlord's caches.
  get engagedCache() {
    return Memory.colonyData?.[this.colony.name]?.towerEngaged || {};
  }

  set engagedCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].towerEngaged = value;
  }

  towers() {
    return this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });
  }

  // --------------------------------------------------------------------------
  //  Placement: realize the planned tower tiles up to the current RCL cap (RCL3 = 1,
  //  RCL5 = 2, RCL7 = 3, RCL8 = 6). The unified RoomPlanner (#258) placed them
  //  central to the base at founding.
  // --------------------------------------------------------------------------
  planTowers() {
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_TOWER] || {})[this.colony.controller.level] || 0;
    if (cap === 0) return; // towers not unlocked yet (RCL < 3)
    StructureRealizer.ensureSites(this.room, STRUCTURE_TOWER, RoomPlanner.tilesFor(this.colony, STRUCTURE_TOWER), cap);
  }

  // --------------------------------------------------------------------------
  //  Operation: one action per tower per tick, attack > heal > repair. Targets
  //  are gathered once per tick by run() and passed in (see its comment).
  // --------------------------------------------------------------------------
  // Returns the hostile this tower attacked (for engagement logging), else null.
  operateTower(tower, hostiles, healTarget, repairTarget) {
    // 1. Attack the closest hostile (closest = least range falloff). Always
    //    fires, regardless of the energy reserve — fighting is the point.
    if (hostiles.length > 0) {
      const target = tower.pos.findClosestByRange(hostiles);
      // Only report it as engaged if the shot actually landed — a dry tower
      // (ERR_NOT_ENOUGH_ENERGY) fired nothing, so it didn't engage anyone.
      return tower.attack(target) === OK ? target : null;
    }

    // 2. Heal the most-damaged friendly creep. Also unreserved — keeping our own
    //    creeps alive is defensive.
    if (healTarget) {
      tower.heal(healTarget);
      return null;
    }

    // 3. Idle repair — only while we hold more than the combat reserve, so a
    //    sudden attack still has ammo. (The target itself excludes walls/ramparts
    //    — see repairTarget.)
    if (repairTarget && tower.store[RESOURCE_ENERGY] > TOWER_ENERGY_RESERVE) {
      tower.repair(repairTarget);
    }
    return null;
  }

  // The most-worn structure worth a tower's energy (a road/container/etc.):
  // lowest hits/hitsMax ratio, excluding walls/ramparts whose huge hit pools
  // would drain the tower dry. Returns null when nothing needs repair.
  repairTarget() {
    const damaged = this.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.hits < s.hitsMax &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART,
    });
    return damaged.length > 0 ? this.mostDamaged(damaged) : null;
  }

  // The object with the lowest hits/hitsMax ratio (most worn relative to its
  // own pool) — used for both heal and repair target selection.
  mostDamaged(objects) {
    return objects.reduce((worst, o) =>
      o.hits / o.hitsMax < worst.hits / worst.hitsMax ? o : worst
    );
  }
}
