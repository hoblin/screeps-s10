import { Role } from "./Role.js";
import { Hauler } from "./Hauler.js";

// Upgrader: keeps the controller leveled. Once a controller container exists (a
// container two tiles short of the controller that haulers keep filled), it parks
// on/beside it — withdrawing energy at range 1 — and upgrades the controller at
// range 3, never walking back to a source container. The dist-2 placement keeps
// both ranges satisfied from one parking tile. Before that container is built, it
// falls back to the generic gather logic.
export class Upgrader extends Role {
  // Controller progress yields to logistics: an upgrader parked by the
  // controller container must step aside so the hauler can deliver to it.
  static movementPriority = 3;

  static run(creep, colony) {
    const working = Role.updateWorkingState(creep);
    const controller = colony.controller;

    if (working) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controller);
      }
    } else {
      this.gather(creep, colony);
    }
  }

  // Gather energy, preferring the CONTROLLER container specifically (reusing
  // Hauler's identification so source-vs-controller logic lives in one place).
  // Once it exists we pull from it — that's the whole point of parking. If it's
  // momentarily empty we briefly hold beside it (a hauler refills it), but we do
  // NOT starve there indefinitely: if energy is already lying around within easy
  // reach we top up from it rather than risk a controller downgrade. Before the
  // container exists, fall back to the generic gather.
  static gather(creep, colony) {
    const controllerContainer = Hauler.controllerContainer(colony);

    // Empty-state moves (withdraw / park at the controller container) run at the
    // gather priority so a parking upgrader never shoves an actively-working
    // creep (#58) — same rule as Role.gatherEnergy.
    const move = (target) => creep.travelTo(target, { priority: Role.gatherMovementPriority });

    if (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        move(controllerContainer);
      }
      return;
    }

    if (controllerContainer) {
      // Container exists but is empty. Prefer to wait beside it (parking next to
      // it also keeps us in upgrade range, so a refill costs no walking). But if
      // there's energy within a few tiles right now — dropped piles, a tomb, or
      // any non-source container we can reach quickly — grab that instead of
      // idling, so a slow/missing hauler can't stall the controller toward
      // downgrade. Source containers stay off-limits: that round trip is exactly
      // what parking exists to avoid.
      if (!creep.pos.inRangeTo(controllerContainer, 1)) {
        move(controllerContainer);
      } else if (this.reachableSpareEnergy(creep, colony)) {
        Role.gatherEnergy(creep, colony);
      }
      return;
    }

    // No controller container yet (early game): self-serve generically.
    Role.gatherEnergy(creep, colony);
  }

  // Is there non-source energy close enough that topping up from it beats idling
  // at an empty controller container? Looks for dropped energy / tombstones near
  // the upgrader; deliberately ignores source containers (the long commute we're
  // avoiding). Cheap range scan, no pathfinding.
  static reachableSpareEnergy(creep, colony) {
    const SCAN = 5;
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, SCAN, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0,
    });
    if (dropped.length > 0) return true;

    const tombs = creep.pos.findInRange(FIND_TOMBSTONES, SCAN, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });
    if (tombs.length > 0) return true;

    const spareContainers = creep.pos.findInRange(FIND_STRUCTURES, SCAN, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > 0 &&
        !Hauler.isSourceContainer(s, colony),
    });
    return spareContainers.length > 0;
  }
}
