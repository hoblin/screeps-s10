import { Overlord } from "./Overlord.js";
import { Harvester } from "../roles/Harvester.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// Mines all sources in the room. One harvester per source (simple S10 start).
export class MiningOverlord extends Overlord {
  constructor(colony) {
    super(colony, 1); // highest priority: no energy = no colony
  }

  get role() {
    return "harvester";
  }

  desiredCount() {
    return this.colony.sources.length;
  }

  bodyFor(energy) {
    // Scale WORK up to 5 (5*2=10 energy/tick = full source drain), keep 1 CARRY 1 MOVE base.
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK], max: 5, energy });
  }

  runCreep(creep) {
    Harvester.run(creep, this.colony);
  }
}
