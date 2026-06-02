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
  static gatherEnergy(creep) {
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

    // 3. Last resort: harvest a source directly
    const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
    if (source) {
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.travelTo(source);
    }
  }
}
