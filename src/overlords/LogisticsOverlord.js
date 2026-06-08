import { Overlord } from "./Overlord.js";
import { Hauler } from "../roles/Hauler.js";
import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  LogisticsOverlord — owns the colony's haulers (energy transport).
//
//  Prepared in advance, activated by a trigger: the overlord always exists but
//  requests ZERO haulers until the colony reaches 2b:Hauling (a source container
//  is finished, so a static miner is filling it). Before that, workers self-serve
//  and a hauler would just idle.
//
//  FLEET SIZING is the freight-turnover model (#84), now owned by Colony.freightHaulers() so the home
//  hauler target is single-sourced — this overlord sizes its fleet from it, and expansionReadiness gates on
//  the SAME number (a per-source count drifted from the freight model and stalled expansion, #272). The
//  overlord only ORCHESTRATES: it gates the freight target on the hauling stage.
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

  // The freight-model fleet (Colony.freightHaulers), gated to zero until the hauling stage (before that,
  // workers self-serve and a hauler would just idle).
  desiredCount() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return 0;
    return this.colony.freightHaulers();
  }

  bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget);
  }

  runCreep(creep) {
    Hauler.run(creep, this.colony);
  }
}
