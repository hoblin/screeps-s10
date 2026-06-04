import { Overlord } from "./Overlord.js";
import { TowerPlanner } from "../lib/TowerPlanner.js";
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

    // Collect who each tower fired at this tick, so we can log engagements and
    // kills against last tick's set (#107).
    const engaged = {};
    for (const tower of towers) {
      const target = this.operateTower(tower, hostiles, healTarget, repairTarget);
      if (target) engaged[target.id] = { hits: target.hits, owner: target.owner.username };
    }
    this.logEngagements(prevEngaged, engaged, towers.length);
    this.engagedCache = engaged;
  }

  // Story-log tower combat (#107): a target we just started firing at → "engaged";
  // a target we were firing at that vanished → "killed" if it COULD have died to our
  // towers (last hits ≤ the max damage they can deal), else "fled". The fled/killed
  // split is a heuristic — the API gives no kill signal (a dead and a border-crossed
  // creep both just disappear) — but last-hits-vs-max-damage is a sound bound: a
  // creep above our max damage definitely didn't die to us.
  logEngagements(prev, current, towerCount) {
    for (const id in current) {
      if (!(id in prev)) {
        const c = current[id];
        RoomLog.record(this.room.name, "🗼 engaged", { owner: c.owner, hp: c.hits });
      }
    }
    const maxDamage = towerCount * TOWER_POWER_ATTACK;
    for (const id in prev) {
      if (id in current) continue;
      const c = prev[id];
      if (c.hits <= maxDamage) RoomLog.record(this.room.name, "💀 killed", { owner: c.owner });
      else RoomLog.record(this.room.name, "🏃 fled", { owner: c.owner, hp: c.hits });
    }
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
  //  Placement: keep tower construction sites alive on central tiles (covering
  //  spawn + controller), up to the current RCL cap (RCL3 = 1, RCL5 = 2, ...).
  // --------------------------------------------------------------------------
  planTowers() {
    const anchor = this.colony.spawns[0];
    if (!anchor) return; // no spawn to anchor the layout (pre-bootstrap)

    const rcl = this.colony.controller.level;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_TOWER] || {})[rcl] || 0;
    if (cap === 0) return; // towers not unlocked yet (RCL < 3)

    TowerPlanner.ensureSites(this.room, this.towerLayout(anchor), cap);
  }

  // The planned tower tiles, computed once via TowerPlanner and cached in colony
  // memory (mirrors Hatchery.extensionLayout). Deterministic from terrain + the
  // spawn/controller anchors, so caching keeps the spiral scan off the per-tick
  // budget. We plan for the RCL8 maximum up front so the layout never shifts as
  // RCL climbs — only the cap we fill it to grows.
  towerLayout(anchor) {
    const cached = this.towerLayoutCache;
    if (cached) {
      return cached.map((p) => new RoomPosition(p.x, p.y, p.roomName));
    }
    const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][8];
    const center = TowerPlanner.centerTile(anchor.pos, this.colony.controller.pos);
    const planned = TowerPlanner.planPositions(this.room, center, anchor.pos, maxTowers);
    this.towerLayoutCache = planned.map((p) => ({
      x: p.x,
      y: p.y,
      roomName: p.roomName,
    }));
    return planned;
  }

  get towerLayoutCache() {
    return Memory.colonyData?.[this.colony.name]?.towerPositions;
  }

  set towerLayoutCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].towerPositions = value;
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
      tower.attack(target);
      return target;
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
