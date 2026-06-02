import { Overlord } from "./Overlord.js";
import { Hauler } from "../roles/Hauler.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  LogisticsOverlord — owns the colony's haulers (energy transport).
//
//  This is "prepared in advance, activated by a trigger" in action: the overlord
//  always exists, but it requests ZERO haulers until the colony reaches the
//  2b:Hauling stage (a source container is finished, so a static miner is now
//  filling it). The moment that trigger fires, desiredCount jumps and haulers
//  spawn — no code change, no manual intervention. Before the trigger, workers
//  self-serve from the source directly and a hauler would just idle.
// ============================================================================
export class LogisticsOverlord extends Overlord {
  constructor(colony) {
    // Priority 3: after miners (1) and workers (2), before upgraders (4).
    // Moving energy matters more than upgrading once we're hauling.
    super(colony, { priority: 3 });
  }

  get role() {
    return "hauler";
  }

  // No haulers until the hauling stage is active. Once active, one hauler per
  // source (each producing container needs draining). We grow throughput via
  // bigger BODIES (more CARRY) rather than more creeps — fewer creeps means less
  // path-contention and CPU, and a single full-size hauler comfortably keeps up
  // with one source's 10 energy/tick over typical early distances. Revisit the
  // ratio if telemetry shows containers backing up.
  desiredCount() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return 0;
    return this.colony.sources.length;
  }

  // Balanced CARRY/MOVE hauler so it moves at full speed on roads and half speed
  // off-road while loaded. Scale capacity up with the energy budget.
  bodyFor(energyBudget) {
    return bodyFromTemplate([CARRY, MOVE], {
      extra: [CARRY, MOVE],
      max: 5, // up to 6×CARRY (300 capacity) + 6×MOVE
      energy: energyBudget,
    });
  }

  runCreep(creep) {
    Hauler.run(creep, this.colony);
  }
}
