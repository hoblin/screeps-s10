import { Role } from "./Role.js";
import { Hauler } from "./Hauler.js";

// Upgrader: keeps the controller leveled. Parks beside the controller container
// (a container hugging the controller that haulers keep filled) and pulls energy
// from one tile away, so it never walks back to a source container. Falls back
// to the generic gather logic before that container exists.
export class Upgrader extends Role {
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
  // Hauler's identification so source vs controller logic lives in one place).
  // Once it exists, pull from it and never from a source container — that's the
  // whole point of parking. Before it exists, fall back to the generic gather.
  static gather(creep, colony) {
    const controllerContainer = Hauler.controllerContainer(colony);
    if (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controllerContainer);
      }
      return;
    }

    // If the controller container exists but is momentarily empty, wait beside
    // it (and within upgrade range of the controller) rather than wandering off
    // to a source container — a hauler will refill it shortly.
    if (controllerContainer) {
      if (!creep.pos.inRangeTo(controllerContainer, 1)) {
        creep.travelTo(controllerContainer);
      }
      return;
    }

    // No controller container yet (early game): self-serve generically.
    Role.gatherEnergy(creep);
  }
}
