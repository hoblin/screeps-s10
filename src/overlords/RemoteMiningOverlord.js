import { Overlord } from "./Overlord.js";
import { RemoteMiner } from "../roles/RemoteMiner.js";

// ============================================================================
//  RemoteMiningOverlord — mines the colony's remote target source (#18, C2).
//
//  Singleton, health-gated: requests 0 miners until colony.health.expansionReady
//  (#89) and the static map (#88) offers a safe, reachable remote (the same target
//  ReserveOverlord reserves — both ask colony.remoteSource()/remoteTarget()). Then
//  it sends ONE RemoteMiner to the target's best source. v1 mines a single source
//  (MVP); scaling to every source of the target is a later step.
// ============================================================================
export class RemoteMiningOverlord extends Overlord {
  constructor(colony) {
    // Priority 5: after the whole home economy — expansion spends only surplus.
    super(colony, { priority: 5 });
  }

  get role() {
    return "remoteMiner";
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.colony.remoteSource() ? 1 : 0;
  }

  bodyFor(energyBudget) {
    return RemoteMiner.bodyFor(energyBudget);
  }

  // No target stamp needed: RemoteMiner reads colony.remoteSource() live each tick
  // (#105), so it re-routes itself when the target room is contested. The base
  // generateSpawnRequest (role/colony/overlord tags) is enough.
  runCreep(creep) {
    RemoteMiner.run(creep, this.colony);
  }
}
