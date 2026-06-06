import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Debug } from "../lib/Debug.js";

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
  // High movement priority (just below the miner): a hauler distributes energy
  // to the whole colony, so a blocked hauler stalls everything — it must be able
  // to shove idle consumers out of its delivery lane (issue #55).
  static movementPriority = 2;

  // Balanced CARRY/MOVE hauler body: full speed on roads, half speed off-road while
  // loaded. Capacity scales with the energy budget — up to 6×CARRY (300).
  static bodyFor(energyBudget) {
    return bodyFromTemplate([CARRY, MOVE], { extra: [CARRY, MOVE], max: 5, energy: energyBudget });
  }

  // Carry capacity (energy) this body holds at a given budget. The logistics fleet
  // divides freight demand by one hauler's turnover, which is built from this (#84).
  static capacityAt(energyBudget) {
    return this.bodyFor(energyBudget).filter((part) => part === CARRY).length * CARRY_CAPACITY;
  }

  static run(creep, colony) {
    // The home hauler's own collect/deliver are the cycle's phase conduct (`this`
    // resolves to Hauler, or a subclass when called as Subclass.run).
    this.runCycle(creep, colony, this);
  }

  // The gather↔deliver FSM skeleton, shared by the home hauler and the remote-haul
  // behavior (#204). It flips `working` at the two load edges, clears the per-trip
  // `haulTarget` latch on the full-load edge, and dispatches to the supplied
  // `conduct`'s collect/deliver. The conduct is a class with static collect/deliver
  // (Hauler for the home fleet, RemoteHaul for the remote behavior) — passed in so
  // the remote behavior reuses this cycle WITHOUT inheriting the home source-container
  // pickup. The two load edges (updateWorkingState already flips `working` here):
  //  • FULL LOAD  (collecting → delivering): pickup commitment fulfilled → drop target.
  //  • FULL UNLOAD (delivering → collecting): next collect tick picks a fresh target.
  // Re-evaluating the target mid-trip is what made haulers oscillate (#86).
  static runCycle(creep, colony, conduct) {
    const wasDelivering = creep.memory.working || false;
    const delivering = Role.updateWorkingState(creep);
    // Seed debug event (#215): the gather↔deliver TRANSITION (the economy analog of a
    // behavior change). No-op unless this creep/role is debug-enabled.
    if (delivering !== wasDelivering) {
      Debug.for(creep.memory.role, creep.name).event(() => ({
        ev: delivering ? "deliver" : "gather",
        room: creep.pos.roomName, x: creep.pos.x, y: creep.pos.y,
        e: creep.store.getUsedCapacity(RESOURCE_ENERGY),
      }));
    }
    if (delivering && !wasDelivering) creep.memory.haulTarget = null;
    if (delivering) {
      conduct.deliver(creep, colony);
    } else {
      conduct.collect(creep, colony);
    }
  }

  // ---- collect: pull energy from the fullest source container --------------
  static collect(creep, colony) {
    // Haulers NEVER pick energy off the ground (#76) — that's worker/upgrader
    // territory (they grab loose energy while gathering). A hauler that picked
    // up dropped energy would re-collect its own deliver-fallback drop near the
    // controller and oscillate in place instead of draining the miner's
    // container. So a hauler drains source containers only; with pickup gone the
    // "drop near controller" fallback becomes a clean pump (container → pile at
    // the controller → upgraders/workers) instead of a self-feeding loop.
    // Commit to ONE container per trip. Re-picking the fullest every tick made
    // haulers reverse mid-route the moment another hauler drained a container and a
    // different one became fullest — they oscillated and never arrived, doubling the
    // freight tonne-km (#86). So we latch the chosen container in memory and stick to
    // it until it's drained or we're full; the next choice happens only after we've
    // delivered. A stable target also lets travelTo keep its cached path.
    let container = this.committedPickup(creep);
    if (!container) {
      // No valid commitment. If we already carry energy (our container drained mid-
      // load), deliver the partial load rather than chase a new target mid-route —
      // that re-pick IS the oscillation. Only pick a fresh target when empty.
      if (creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.working = true;
        return this.deliver(creep, colony); // deliver() stamps its own note this tick
      }
      container = this.fullestSourceContainer(creep, colony);
      creep.memory.haulTarget = container ? container.id : null;
    }
    if (container) {
      this.note(creep, "haul:withdraw");
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(container);
      }
      return;
    }

    // Nothing to haul yet — idle near the first spawn so we're ready.
    this.note(creep, "haul:idle");
    if (colony.spawns[0]) creep.travelTo(colony.spawns[0]);
  }

  // The pickup container we committed to last tick, if it still exists and still
  // holds energy. Clears and returns null when the commitment is gone or drained, so
  // the caller re-decides (deliver a partial load, or pick a fresh target).
  static committedPickup(creep) {
    const id = creep.memory.haulTarget;
    if (!id) return null;
    const container = Game.getObjectById(id);
    if (!container || container.store[RESOURCE_ENERGY] === 0) {
      creep.memory.haulTarget = null;
      return null;
    }
    return container;
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
      this.note(creep, "deliver:spawn");
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
      this.note(creep, "deliver:tower");
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
      this.note(creep, "deliver:ctrl-container");
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controllerContainer);
      }
      return;
    }

    // 4. Storage buffer (mid-game) — park surplus there.
    const storage = colony.room.storage;
    if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      this.note(creep, "deliver:storage");
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
      this.note(creep, "deliver:ctrl-container-full");
      if (creep.transfer(anyControllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(anyControllerContainer);
      }
      return;
    }
    if (colony.controller) {
      this.note(creep, "deliver:drop");
      if (creep.pos.inRangeTo(colony.controller, 3)) {
        creep.drop(RESOURCE_ENERGY);
      } else {
        creep.travelTo(colony.controller);
      }
    }
  }

  // The controller container — the colony owns this structure query now (it knows
  // its own geometry/structures). Kept as a Hauler entry point so the delivery
  // callers above stay unchanged.
  static controllerContainer(colony) {
    return colony.controllerContainer();
  }

  // isSourceContainer lives on the base Role (the one definition every role
  // shares); Hauler.isSourceContainer(...) still resolves here via static
  // inheritance, so existing callers stay unchanged.
}
