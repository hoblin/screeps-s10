import { Overlord } from "./Overlord.js";
import { Upgrader } from "../roles/Upgrader.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// Keeps the room controller leveling. Scales count with available energy.
export class UpgradeOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 4 });
  }

  get role() {
    return "upgrader";
  }

  desiredCount() {
    // 1 baseline; 2 once we have some extension capacity.
    return this.room.energyCapacityAvailable >= 550 ? 2 : 1;
  }

  bodyFor(energy) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 4, energy });
  }

  runCreep(creep) {
    Upgrader.run(creep, this.colony);
  }
}
