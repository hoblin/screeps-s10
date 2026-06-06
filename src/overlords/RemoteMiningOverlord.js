import { Overlord } from "./Overlord.js";
import { RemoteMiner } from "../roles/RemoteMiner.js";
import { Miner } from "../roles/Miner.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteMiningOverlord — owns the whole remote-mining domain (#18 C2, #102).
//
//  ONE controller for ALL remote sources (not one-per-source): an Overlord is a
//  stateless controller over a domain, and the stateful things — a source's tile,
//  a miner's current assignment, a room's threat — are the model (the static map,
//  creep memory, the intel overlay). Owning the domain in one place is what makes
//  cross-source decisions trivial: when a room turns economy-unsafe (Threat.isHotForEconomy,
//  #150) we re-home its miners onto a free safe source (or pull them back) with full
//  visibility — no coordination
//  between per-source instances.
//
//  Allocation: one miner per safe source (reachable + not currently hot), value
//  best-first. Each miner's source is stamped in its memory (its model); the
//  controller hands out assignments on spawn and reconciles them every tick.
//
//  STAFFING (#210): one miner per safe source, PLUS a just-in-time relief pre-spawned for a dying
//  incumbent (#168 generalized per-source — the ~dist×3 remote trip is long, so without JIT a source
//  sat minerless for the whole spawn+travel gap every cycle). Gated on health.expansionReady — which is
//  now HOME-ECONOMY HEALTH, not spawn-idle (the old spawn-idle gate was eaten by the score-scout fleet
//  #170 and starved the remotes). Spawn priority 2 (above scouts) so remote income isn't starved by the
//  score fleet in the queue. v1 drop-mines (no remote container).
// ============================================================================
const key = (s) => `${s.room}:${s.x}:${s.y}`;

export class RemoteMiningOverlord extends Overlord {
  constructor(colony) {
    // Priority 2 (above scouts, #210): remote income must not be starved by the score-scout fleet in the
    // spawn queue. expansionReady (home-economy health) ensures it only requests when home is staffed, so
    // it never preempts a needed home unit — and the Hatchery serves home-critical (1) first regardless.
    super(colony, { priority: 2 });
  }

  get role() {
    return "remoteMiner";
  }

  // The domain's current target set: every mineable remote source whose room is
  // economy-safe right now (Threat.isHotForEconomy, #150 — a guard-held room still
  // counts; only an under-defended threat excludes it). Value-ranked (remoteSources() sorts).
  safeSources() {
    return this.colony.remoteSources().filter((s) => !Threat.isHotForEconomy(s.room));
  }

  // One miner per safe source, plus a JIT relief per dying incumbent so a source is never left minerless
  // across the long spawn+travel gap (#210/#168). Gated wholesale on expansionReady — now home-economy
  // HEALTH (#210), which also folds in the recovery crisis (it returns false while recovering). The
  // dying-incumbent +1 is balanced by its relief in assignedCreeps, so exactly one relief per dying source.
  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    const safe = this.safeSources();
    const safeKeys = new Set(safe.map(key));
    const dying = this.assignedCreeps.filter(
      (c) => c.memory.remoteSource && safeKeys.has(key(c.memory.remoteSource)) && this.isDying(c)
    ).length;
    return safe.length + dying;
  }

  // A live incumbent within its (spawn + travel) replacement lead of dying — the JIT trigger. Uses the
  // SOURCE's own haul distance (large for a remote), so the relief leaves early enough to arrive as the
  // incumbent expires. Spawning/fresh creeps (ttl undefined / ≈ full) sit far above the lead.
  isDying(creep) {
    if (creep.ticksToLive === undefined) return false;
    const a = creep.memory.remoteSource;
    // Guard finiteness, not just null: a legacy/corrupt Infinity dist would make the lead Infinity →
    // ttl < Infinity always true → endless relief spam; NaN would misclassify. Non-finite → not dying.
    if (!a || !Number.isFinite(a.dist)) return false;
    const lead = Miner.replacementLead(RemoteMiner.bodyFor(this.colony.spawnEnergyBudget()), a.dist);
    return creep.ticksToLive < lead;
  }

  bodyFor(energyBudget) {
    return RemoteMiner.bodyFor(energyBudget);
  }

  // Stamp the source a new miner takes. JIT FIRST: if a safe source's lone incumbent is dying with no
  // relief inbound yet, bind the relief to THAT source — the uncovered-scan below would skip it (the
  // dying incumbent still counts the source as covered). Else open the best uncovered safe source.
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (!req) return null;
    const relief = this.sourceNeedingRelief();
    if (relief) {
      req.memory.remoteSource = { ...relief };
      return req;
    }
    const covered = this.coveredSources();
    const s = this.safeSources().find((src) => !covered.has(key(src)));
    if (!s) return null; // every safe source already has a miner
    req.memory.remoteSource = { room: s.room, x: s.x, y: s.y, dist: s.dist };
    return req;
  }

  // The remoteSource of a safe source whose ONLY assigned miner is a dying incumbent (no relief inbound
  // yet). Per-source grouping so two sources dying at once each get exactly one relief, and a source
  // already being relieved (2 miners) is skipped — the base spawn gate then orders no duplicate.
  sourceNeedingRelief() {
    const safeKeys = new Set(this.safeSources().map(key));
    const bySource = {};
    for (const c of this.assignedCreeps) {
      const a = c.memory.remoteSource;
      if (!a || !safeKeys.has(key(a))) continue;
      (bySource[key(a)] ||= []).push(c);
    }
    for (const k in bySource) {
      const crew = bySource[k];
      if (crew.length === 1 && this.isDying(crew[0])) return crew[0].memory.remoteSource;
    }
    return null;
  }

  // Source keys currently assigned to a live miner.
  coveredSources() {
    return new Set(
      this.assignedCreeps.map((c) => c.memory.remoteSource).filter(Boolean).map(key)
    );
  }

  // Reconcile assignments before driving — this is the domain reroute, all in one
  // owner. A miner whose source went hot is moved onto a free safe source if one
  // exists (productive re-home); with none free it keeps its assignment and the role
  // holds it home until the room cools; an assignment that left the map entirely
  // (legacy creep from before #102, or a re-scan) is cleared so the role recycles it.
  run() {
    const safe = this.safeSources();
    const safeKeys = new Set(safe.map(key));
    const mapKeys = new Set(this.colony.remoteSources().map(key));
    const covered = new Set(
      this.assignedCreeps
        .map((c) => c.memory.remoteSource)
        .filter((a) => a && safeKeys.has(key(a)))
        .map(key)
    );
    for (const creep of this.assignedCreeps) {
      const a = creep.memory.remoteSource;
      if (a && safeKeys.has(key(a))) continue; // already mining a safe source
      const free = safe.find((s) => !covered.has(key(s)));
      if (free) {
        creep.memory.remoteSource = { room: free.room, x: free.x, y: free.y, dist: free.dist };
        creep.memory.miningPos = null; // invalidate the old source's parking tile on re-home
        covered.add(key(free));
      } else if (!a || !mapKeys.has(key(a))) {
        creep.memory.remoteSource = null; // orphan/off-map → role recycles it
      }
      // else: assignment is hot but still on the map and no safe slot is free →
      // keep it; RemoteMiner retreats home and resumes when the room cools.
    }
    super.run();
  }

  runCreep(creep) {
    RemoteMiner.run(creep, this.colony);
  }
}
