import { Role } from "./Role.js";

// Harvester: parks on a source and mines it. Drops energy / fills adjacent
// container. In the simple S10 start it also hauls to spawn if no container yet.
export class Harvester extends Role {
  static run(creep, colony) {
    // Assign a source once, stable across ticks.
    if (!creep.memory.sourceId) {
      const taken = colony
        .creepsWithRole("harvester")
        .map((c) => c.memory.sourceId)
        .filter(Boolean);
      const free = colony.sources.find((s) => !taken.includes(s.id));
      creep.memory.sourceId = (free || colony.sources[0]).id;
    }

    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) return;

    if (creep.store.getFreeCapacity() > 0 || colony.spawns.length === 0) {
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.travelTo(source);
      return;
    }

    // Full: deliver to the closest spawn/extension that needs energy.
    const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (target) {
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(target);
    } else {
      // Nowhere to put it — just keep mining and let it drop.
      creep.harvest(source);
    }
  }
}
