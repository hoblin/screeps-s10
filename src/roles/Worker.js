import { Role } from "./Role.js";
import { stageAtLeast } from "../lib/Stages.js";

// Worker: priority chain — fill spawn/extensions > build > repair > upgrade.
// Once haulers are active (2b:Hauling), workers STOP filling spawn/extensions
// and leave that to dedicated haulers — otherwise both race for the same
// targets, wasting trips and CPU. Workers then focus on build/repair/upgrade.
export class Worker extends Role {
  static run(creep, colony) {
    const working = Role.updateWorkingState(creep);

    if (!working) {
      Role.gatherEnergy(creep);
      return;
    }

    // 1. Fill spawns & extensions — ONLY while haulers aren't doing it yet.
    if (!stageAtLeast(colony, "2b:Hauling")) {
      const fill = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      });
      if (fill) {
        if (creep.transfer(fill, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(fill);
        return;
      }
    }

    // 2. Build construction sites.
    const site = creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES);
    if (site) {
      if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
      return;
    }

    // 3. Repair damaged structures (skip walls/ramparts for now).
    const repair = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: (s) =>
        s.hits < s.hitsMax &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART,
    });
    if (repair) {
      if (creep.repair(repair) === ERR_NOT_IN_RANGE) creep.travelTo(repair);
      return;
    }

    // 4. Idle fallback: help upgrade.
    if (creep.upgradeController(colony.controller) === ERR_NOT_IN_RANGE) {
      creep.travelTo(colony.controller);
    }
  }
}
