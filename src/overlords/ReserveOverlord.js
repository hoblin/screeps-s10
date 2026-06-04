import { Overlord } from "./Overlord.js";
import { Reserver } from "../roles/Reserver.js";

// ============================================================================
//  ReserveOverlord — reserves the best safe adjacent remote (#18, slice C1).
//
//  Prepared-in-advance, HEALTH-triggered (not stage-gated): requests 0 reservers
//  until the home economy is ready to invest — colony.health.expansionReady (#89)
//  — AND the static expansion map (#88) offers a safe, mineable neighbour. Then it
//  sends ONE reserver to the top-ranked remote, boosting that room's sources to
//  3000/300 ahead of the remote miners (slice C2).
//
//  Target selection is pure orchestration: read the map, pick the best remote we
//  can safely reserve. The map already filtered Source-Keeper and enemy rooms; the
//  Reserver role does the live hostile check on arrival. expansionReady is
//  self-throttling — if reserving strains the spawn, the latch releases and this
//  drops back to 0, so expansion never starves the core.
// ============================================================================
export class ReserveOverlord extends Overlord {
  constructor(colony) {
    // Priority 5: after the whole home economy (mining 1, work 2, haul 3,
    // upgrade 4) — expansion spends only the surplus, never ahead of the core.
    super(colony, { priority: 5 });
  }

  get role() {
    return "reserver";
  }

  // The best safe remote to reserve, or null: the top-ranked map entry not already
  // reserved by someone else. One target in v1.
  target() {
    return this.colony.remoteTarget(); // shared with the remote mining/logistics overlords
  }

  // One reserver for the top remote — but only once the home economy has spare
  // capacity to invest (#89) and a target exists. No stage gate: expansionReady
  // (spawn-idle + crisis-clear + can-afford-a-reserver) IS the readiness condition.
  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.target() ? 1 : 0;
  }

  bodyFor(energyBudget) {
    return Reserver.bodyFor(energyBudget);
  }

  // Stamp the chosen remote's room + controller tile so the Reserver knows where
  // to go without re-reading the map (mirrors how MiningOverlord stamps its source).
  generateSpawnRequest() {
    const request = super.generateSpawnRequest();
    if (!request) return null;
    const target = this.target();
    if (!target) return null; // target vanished between desiredCount and now
    request.memory.targetRoom = target.room;
    request.memory.controllerPos = target.controller;
    return request;
  }

  runCreep(creep) {
    Reserver.run(creep, this.colony);
  }
}
