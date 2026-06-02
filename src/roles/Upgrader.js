import { Role } from "./Role.js";

// Upgrader: keeps the controller leveled. Gathers energy, then upgrades.
export class Upgrader extends Role {
  static run(creep, colony) {
    const working = Role.updateWorkingState(creep);
    const controller = colony.controller;

    if (working) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.travelTo(controller);
      }
    } else {
      Role.gatherEnergy(creep);
    }
  }
}
