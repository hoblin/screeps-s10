import { Overlord } from "./Overlord.js";
import { RemoteHauler } from "../roles/RemoteHauler.js";
import { Hauler } from "../roles/Hauler.js";
import { Miner } from "../roles/Miner.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteLogisticsOverlord — hauls ALL mined remote sources home (#18 C2, #102).
//
//  ONE shared fleet (mirroring the single home LogisticsOverlord), sized with the
//  SAME freight-turnover model (#84) summed over every source we're actually mining:
//    N = ceil( 2·Σ(r·d)·margin / (C·v) )
//  r = a remote miner's output, d = that source's one-way haul (static map), C =
//  hauler capacity. Demand is summed only over sources with a LIVE miner in a
//  non-hot room — so the fleet tracks real production (it grows as miners come
//  online, not ahead of them) and ignores contested rooms. Sustaining this haul of
//  already-committed production is NOT expansion (it collects a return on a remote we
//  already paid for), so it is NOT expansionReady-gated (#131): expansionReady is the
//  "start a NEW remote" trigger and self-throttles to false when the spawn is busy —
//  exactly when active miners need haulers most. Demand follows the active miners; only
//  the recovering crisis floor zeroes it. Haulers pool across sources by need, picking
//  the fullest remote pile each trip (RemoteHauler) rather than welding to one.
// ============================================================================
const HAULER_SPEED = 1; // tiles/tick on roads/plains for a 1:1 CARRY:MOVE body
const FREIGHT_MARGIN = 1.3; // same headroom as the home freight model (#84)

export class RemoteLogisticsOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // after the home economy
  }

  get role() {
    return "remoteHauler";
  }

  desiredCount() {
    if (this.colony.health.recovering) return 0; // crisis floor only — sustaining active production isn't expansion (#131)
    const cap = this.colony.room.energyCapacityAvailable;
    const carry = Hauler.capacityAt(cap);
    if (!carry) return 0;
    const rate = Miner.harvestRateAt(cap); // energy/tick one remote miner produces

    // Only count sources whose miner has actually ARRIVED at its source room (not
    // spawning, not still crossing the border, not retreating) — sizing for miners
    // that aren't producing yet would spawn haulers ahead of any energy to carry.
    const mined = new Set(
      this.colony.creepsWithRole("remoteMiner")
        .filter((c) => !c.spawning && c.memory.remoteSource && c.room.name === c.memory.remoteSource.room)
        .map((c) => `${c.memory.remoteSource.room}:${c.memory.remoteSource.x}:${c.memory.remoteSource.y}`)
    );
    const demand = this.colony.remoteSources()
      .filter((s) => isFinite(s.dist) && !Threat.isHot(s.room) && mined.has(`${s.room}:${s.x}:${s.y}`))
      .reduce((sum, s) => sum + rate * s.dist, 0); // Σ r·d (tonne-tiles/tick)
    if (demand === 0) return 0;
    return Math.max(1, Math.ceil((2 * demand * FREIGHT_MARGIN) / (carry * HAULER_SPEED)));
  }

  bodyFor(energyBudget) {
    return RemoteHauler.bodyFor(energyBudget);
  }

  // No per-creep target stamp: the fleet is shared and each hauler picks its remote
  // pickup live from colony.remoteSources() (the fullest active pile), re-routing off
  // a contested room on its own (#105). The base spawn tags are enough.
  runCreep(creep) {
    RemoteHauler.run(creep, this.colony);
  }
}
