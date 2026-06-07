import { Overlord } from "./Overlord.js";
import { Hauler } from "../roles/Hauler.js";
import { Miner } from "../roles/Miner.js";
import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  LogisticsOverlord — owns the colony's haulers (energy transport).
//
//  Prepared in advance, activated by a trigger: the overlord always exists but
//  requests ZERO haulers until the colony reaches 2b:Hauling (a source container
//  is finished, so a static miner is filling it). Before that, workers self-serve
//  and a hauler would just idle.
//
//  FLEET SIZING — freight turnover, not a flat per-source count (#84). We size the
//  fleet to the transport work the room produces, in "tonne-tiles per tick":
//
//    demand  D = Σ_sources ( r · d )    r = energy/tick a source yields
//                                       d = tiles from its container to the drop-off
//    one hauler's turnover = C · v / 2  C = carry capacity, v = tiles/tick, /2 for
//                                       the empty return leg. Distance CANCELS here,
//                                       so it enters the model only once, in D.
//    fleet   N = ceil( D · margin / (C · v / 2) )
//
//  This is feed-forward, not feedback: the fleet is sized to predicted production,
//  so energy never piles on the ground waiting to be corrected after a spill. Both
//  r and C are predicted from the spawn-energy cap (bigger cap → bigger miners AND
//  bigger haulers) and d is fixed geometry, so N is a static step-function of
//  energyCapacityAvailable — recomputed only when the cap changes, cached otherwise.
//
//  Each class answers for its own domain: the Miner role gives r (its production),
//  the Hauler role gives C (its capacity), the Colony gives d (its geometry). The
//  overlord only ORCHESTRATES — it composes those answers into a count.
// ============================================================================
const HAULER_SPEED = 1; // tiles/tick: a 1:1 CARRY:MOVE body moves full speed on roads/plains
// Headroom over the idealized C·v/2 turnover (which assumes a hauler is always either
// loaded-outbound or empty-returning). The real duty cycle loses time to load/unload,
// waiting for a container to refill, multi-sink delivery detours, and traffic — so a
// hauler moves less than the ideal. 1.3 covers that AND clears the long-haul container
// overflow seen live on E15S7, where 2 pooled haulers couldn't keep the far source's
// container (d≈23 to the drop-off) drained. Lift it if energy still hits the ground;
// drop it if haulers sit idle.
const FREIGHT_MARGIN = 1.3;

export class LogisticsOverlord extends Overlord {
  constructor(colony) {
    // Priority 3: after miners (1) and workers (2), before upgraders (4).
    // Moving energy matters more than upgrading once we're hauling.
    super(colony, { priority: 3 });
  }

  get role() {
    return "hauler";
  }

  // Hauler headcount from the freight model above. Zero until the hauling stage;
  // then the computed fleet, cached against the spawn cap (the only input that
  // changes it). Falls back to one-per-source while the container geometry isn't
  // known yet (early 2b) — degrades to the old baseline, never to zero.
  desiredCount() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return 0;
    const cap = this.colony.room.energyCapacityAvailable;
    const carry = Hauler.capacityAt(cap); // also key on capacity so a bodyFor change (deploy) recomputes
    const cached = this.fleetCache;
    // Validate the cached count — a corrupt/partial Memory write (undefined/NaN)
    // would otherwise make generateSpawnRequest compare against NaN and spawn
    // haulers forever. A bad value just falls through to recompute/baseline.
    if (cached && cached.cap === cap && cached.carry === carry && Number.isFinite(cached.count)) {
      return cached.count;
    }
    const count = this.computeFleet(cap);
    if (count == null) return this.colony.sources.length; // geometry not ready → baseline
    this.fleetCache = { cap, carry, count };
    return count;
  }

  // The freight model. Returns null when the geometry isn't available yet (a
  // missing or unreachable container), signalling desiredCount to use the baseline.
  computeFleet(cap) {
    const dropoff = this.colony.controllerDropoffPos();
    if (!dropoff) return null;
    const carry = Hauler.capacityAt(cap);
    if (!carry) return null;

    const ratePerSource = Miner.harvestRateAt(cap); // one static miner per source (v1)
    let demand = 0; // tonne-tiles/tick
    for (const source of this.colony.sources) {
      const containerPos = this.colony.sourceContainerPos(source);
      if (!containerPos) return null;
      const distance = this.colony.pathLength(containerPos, dropoff);
      if (!isFinite(distance)) return null;
      demand += ratePerSource * distance;
    }

    const turnoverPerHauler = (carry * HAULER_SPEED) / 2;
    return Math.max(1, Math.ceil((demand * FREIGHT_MARGIN) / turnoverPerHauler));
  }

  // Memoized fleet size, keyed on the spawn cap AND the resulting hauler capacity (the recompute
  // triggers): the path measurement only runs again when an extension completes OR a code change
  // resizes the hauler body. Cross-tick, so it lives in Memory (the overlord is rebuilt every tick).
  get fleetCache() {
    return Memory.colonyData?.[this.colony.name]?.haulerFleet;
  }

  set fleetCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].haulerFleet = value;
  }

  bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget);
  }

  runCreep(creep) {
    Hauler.run(creep, this.colony);
  }
}
