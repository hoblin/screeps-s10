import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  Role — base behaviour shared by all creep roles (the DRY core).
//  Roles are stateless behaviour objects: we call Role.run(creep, colony).
//  We use static methods so there's no per-creep allocation each tick.
//
//  Shared helpers handle the universal "gather energy <-> do work" state
//  toggle that almost every economic creep needs.
// ============================================================================
export class Role {
  // Toggle creep.memory.working between gathering and spending energy.
  // Returns true if the creep should be DOING WORK (spending), false if gathering.
  static updateWorkingState(creep) {
    const m = creep.memory;
    if (m.working && creep.store[RESOURCE_ENERGY] === 0) {
      m.working = false;
      creep.say("⛏️");
    }
    if (!m.working && creep.store.getFreeCapacity() === 0) {
      m.working = true;
      creep.say("⚡");
    }
    return m.working;
  }

  // Gather energy from the cheapest available source: dropped > container/storage > harvest.
  //
  // Direct self-harvest (step 3) is the early-game lifeline that keeps the
  // controller from downgrading before any container exists — but it becomes
  // HARMFUL once hauling is active (2b:Hauling+): a worker/upgrader on a source
  // steals the static miner's spot and double-walks energy the haulers already
  // move. So from 2b on the economy is strictly miner → container → hauler →
  // consumer, and self-harvest is forbidden. Pass `colony` so we can check the
  // stage; without it we assume early game and keep the fallback (the safe
  // default — a missing colony must never let the controller downgrade).
  static gatherEnergy(creep, colony) {
    // 1. Dropped energy nearby
    const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) creep.travelTo(dropped);
      return;
    }

    // 2. Containers / storage with energy
    const store = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        s.store[RESOURCE_ENERGY] > 0,
    });
    if (store) {
      if (creep.withdraw(store, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(store);
      return;
    }

    // 3. Last resort BEFORE hauling: harvest a source directly (keeps the
    //    controller alive while infrastructure is built).
    if (!colony || !stageAtLeast(colony, "2b:Hauling")) {
      const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
      if (source) {
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.travelTo(source);
      }
      return;
    }

    // 4. Hauling is active but nothing is drainable this tick. Don't touch the
    //    source — park beside the nearest container and wait for a hauler to
    //    refill it (it'll be empty now, so step 2 skipped it). The energy
    //    arrives shortly; idling adjacent means we withdraw the instant it does.
    const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE,
    });
    if (container && !creep.pos.inRangeTo(container, 1)) creep.travelTo(container);
  }
}
