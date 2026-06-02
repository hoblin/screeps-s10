import { HiveCluster } from "./HiveCluster.js";
import { log } from "../lib/Logger.js";

// ============================================================================
//  Hatchery — owns the colony's spawns + extensions; turns spawn requests
//  (from Overlords) into actual spawnCreep() calls, highest priority first.
// ============================================================================
export class Hatchery extends HiveCluster {
  constructor(colony) {
    super(colony);
    this.spawns = colony.spawns;
  }

  // requests: [{ priority, role, body, memory }]
  run(requests) {
    if (!requests || requests.length === 0) return;

    const freeSpawn = this.spawns.find((s) => !s.spawning);
    if (!freeSpawn) return;

    // Lowest priority number first.
    requests.sort((a, b) => a.priority - b.priority);
    const req = requests[0];

    const cost = req.body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    if (cost > this.room.energyAvailable) {
      // Not enough energy yet — wait (unless we have zero creeps: emergency).
      const totalCreeps = Object.keys(Game.creeps).length;
      if (totalCreeps > 0) return;
    }

    const name = `${req.role}_${Game.time % 10000}`;
    const result = freeSpawn.spawnCreep(req.body, name, { memory: req.memory });

    if (result === OK) {
      log.info(`[${this.colony.name}] spawning ${name} (${req.body.length} parts, cost ${cost})`);
    } else if (result !== ERR_NOT_ENOUGH_ENERGY && result !== ERR_BUSY) {
      log.warn(`[${this.colony.name}] spawn ${req.role} failed: ${result}`);
    }
  }
}
