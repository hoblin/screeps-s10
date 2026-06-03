import { Role } from "./Role.js";

// ============================================================================
//  Hauler — a logistics creep (Stage 2b economy).
//
//  A hauler is pure transport: CARRY + MOVE, no WORK. Its loop is simple and
//  it never mines:
//    EMPTY  -> go to the fullest source container and withdraw energy
//    FULL   -> deliver energy where it's needed most, in priority order:
//                1. spawns & extensions (so the colony can keep spawning)
//                2. towers (defense — once they exist)
//                3. the controller container (feed upgraders)
//              and if nothing needs filling, drop it in storage (mid-game).
//
//  Haulers exist because static miners drop energy into containers and can't
//  move it. They only make sense once a source container is finished — which is
//  exactly the trigger that promotes the colony into the 2b:Hauling stage and
//  switches LogisticsOverlord on. Before that, workers self-serve and no hauler
//  spawns.
// ============================================================================
export class Hauler extends Role {
  static run(creep, colony) {
    const delivering = Role.updateWorkingState(creep);
    if (delivering) {
      this.deliver(creep, colony);
    } else {
      this.collect(creep, colony);
    }
  }

  // ---- collect: pull energy from the fullest source container --------------
  static collect(creep, colony) {
    // Prefer dropped energy first (a miner with no container yet, or overflow),
    // then the fullest source container. This keeps the floor clean and drains
    // the busiest miner first.
    const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) creep.travelTo(dropped);
      return;
    }

    const sourceContainer = this.fullestSourceContainer(creep, colony);
    if (sourceContainer) {
      if (creep.withdraw(sourceContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(sourceContainer);
      }
      return;
    }

    // Nothing to haul yet — idle near the first spawn so we're ready.
    if (colony.spawns[0]) creep.travelTo(colony.spawns[0]);
  }

  // The source-adjacent container holding the most energy (the one most in need
  // of draining). Returns null if none has energy yet.
  static fullestSourceContainer(creep, colony) {
    const containers = [];
    for (const source of colony.sources) {
      const nearby = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s) =>
          s.structureType === STRUCTURE_CONTAINER &&
          s.store[RESOURCE_ENERGY] > 0,
      });
      containers.push(...nearby);
    }
    if (containers.length === 0) return null;
    return containers.reduce((fullest, c) =>
      c.store[RESOURCE_ENERGY] > fullest.store[RESOURCE_ENERGY] ? c : fullest
    );
  }

  // ---- deliver: fill the highest-priority sink that needs energy -----------
  static deliver(creep, colony) {
    // 1. Spawns & extensions (keep the colony able to spawn).
    const spawnOrExtension = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (spawnOrExtension) {
      if (creep.transfer(spawnOrExtension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(spawnOrExtension);
      }
      return;
    }

    // 2. Towers (defense) — keep them above a working reserve.
    const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_TOWER &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (tower) {
      if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(tower);
      }
      return;
    }

    // 3. Controller container (feeds parked upgraders), if one exists and isn't
    //    a source container. We identify it as a container NOT adjacent to any
    //    source.
    const controllerContainer = this.controllerContainer(colony);
    if (
      controllerContainer &&
      controllerContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    ) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controllerContainer);
      }
      return;
    }

    // 4. Storage buffer (mid-game) — park surplus there.
    const storage = colony.room.storage;
    if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(storage);
      }
      return;
    }

    // 5. Nothing accepts energy (early game: no tower/storage, everything full).
    //    Don't sit full forever — dump into the controller container if one
    //    exists (even if we'd normally skip a full one we already returned
    //    above), otherwise drop the energy on the ground near the controller so
    //    we free up and go collect again. Energy isn't lost; upgraders/workers
    //    pick dropped energy up.
    const anyControllerContainer = this.controllerContainer(colony);
    if (anyControllerContainer) {
      if (creep.transfer(anyControllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(anyControllerContainer);
      }
      return;
    }
    if (colony.controller) {
      if (creep.pos.inRangeTo(colony.controller, 3)) {
        creep.drop(RESOURCE_ENERGY);
      } else {
        creep.travelTo(colony.controller);
      }
    }
  }

  // The controller container — a non-source container within range 3 of the
  // controller. ContainerPlanner places it two tiles short of the controller (up
  // to chebyshev 3 on a constrained approach), so range 3 covers every tile it
  // can pick. The non-source filter keeps it unambiguous: only source and
  // controller containers exist, and source containers are excluded by definition.
  static controllerContainer(colony) {
    if (!colony.controller) return null;
    const near = colony.controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    });
    return near.find((container) => !this.isSourceContainer(container, colony)) || null;
  }

  static isSourceContainer(container, colony) {
    return colony.sources.some(
      (source) => source.pos.getRangeTo(container.pos) <= 1
    );
  }
}
