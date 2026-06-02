import { Overlord } from "./Overlord.js";
import { TowerPlanner } from "../lib/TowerPlanner.js";

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
  run() {
    this.planTowers();
    for (const tower of this.towers()) this.operateTower(tower);
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
  //  Operation: one action per tower per tick, attack > heal > repair.
  // --------------------------------------------------------------------------
  operateTower(tower) {
    // 1. Attack the closest hostile (closest = least range falloff). Always
    //    fires, regardless of the energy reserve — fighting is the point.
    const hostile = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (hostile) {
      tower.attack(hostile);
      return;
    }

    // 2. Heal the most-damaged friendly creep. Also unreserved — keeping our own
    //    creeps alive is defensive.
    const wounded = tower.room.find(FIND_MY_CREEPS, {
      filter: (c) => c.hits < c.hitsMax,
    });
    if (wounded.length > 0) {
      tower.heal(this.mostDamaged(wounded));
      return;
    }

    // 3. Idle repair — only while we hold more than the combat reserve, so a
    //    sudden attack still has ammo. Skip walls/ramparts: their hit pools are
    //    huge and would drain the tower dry; fix the most-worn road/container/etc.
    if (tower.store[RESOURCE_ENERGY] <= TOWER_ENERGY_RESERVE) return;
    const damaged = tower.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.hits < s.hitsMax &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART,
    });
    if (damaged.length > 0) tower.repair(this.mostDamaged(damaged));
  }

  // The object with the lowest hits/hitsMax ratio (most worn relative to its
  // own pool) — used for both heal and repair target selection.
  mostDamaged(objects) {
    return objects.reduce((worst, o) =>
      o.hits / o.hitsMax < worst.hits / worst.hitsMax ? o : worst
    );
  }
}
