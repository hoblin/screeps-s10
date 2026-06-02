import { Role } from "./Role.js";
import { Hauler } from "./Hauler.js";

// Upgrader: keeps the controller leveled. Once a controller container exists (a
// container hugging the controller that haulers keep filled), it parks beside it
// and pulls energy from one tile away — never walking back to a source container.
// Before that container is built, it falls back to the generic gather logic.
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
  // Hauler's identification so source-vs-controller logic lives in one place).
  // Once it exists we pull from it and never from a source container — that's the
  // whole point of parking. Before it exists, fall back to the generic gather.
  static gather(creep, colony) {
    const controllerContainer = Hauler.controllerContainer(colony);

    if (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controllerContainer);
      }
      return;
    }

    // Container exists but is momentarily empty: wait beside it (a hauler will
    // refill it shortly) rather than wandering back to a source container. Since
    // the container hugs the controller, parking next to it also keeps us in
    // upgrade range, so no walking is wasted.
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
