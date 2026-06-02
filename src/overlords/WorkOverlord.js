import { Overlord } from "./Overlord.js";
import { Worker } from "../roles/Worker.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// General-purpose builders/repairers/fillers. Fills spawn+extensions first,
// then builds construction sites, then repairs, else helps upgrade.
export class WorkOverlord extends Overlord {
  constructor(colony) {
    super(colony, 2);
  }

  get role() {
    return "worker";
  }

  desiredCount() {
    const sites = this.room.find(FIND_MY_CONSTRUCTION_SITES).length;
    return sites > 0 ? 3 : 2;
  }

  bodyFor(energy) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 5, energy });
  }

  runCreep(creep) {
    Worker.run(creep, this.colony);
  }
}
