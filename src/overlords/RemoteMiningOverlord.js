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
//  SUSTAIN vs EXPAND gating (#210): keeping an ALREADY-COVERED source staffed — including the
//  just-in-time replacement of a dying incumbent (#168 JIT, generalized per-source here) — is
//  SUSTAINING committed production and is funded UNCONDITIONALLY (only the `recovering` crisis floor
//  yields). OPENING a NEW (uncovered) source is expansion: a spawn-time investment, gated on
//  expansionReady (#89), which self-throttles to spare spawn capacity. Without per-source JIT a remote
//  source sat minerless for the whole spawn+travel gap every cycle (the ~dist×3 trip is long), so
//  ~half the sources had no miner at any moment. v1 drop-mines (no remote container).
// ============================================================================
const key = (s) => `${s.room}:${s.x}:${s.y}`;

export class RemoteMiningOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // singleton: priority after the home economy
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

  // SUSTAIN (always) + EXPAND (gated). Sustain = keep every already-covered safe source staffed, plus
  // pre-spawn a JIT relief for each dying incumbent (#210/#168) — committed production, unconditional.
  // Expand = open the remaining uncovered safe sources — only when expansionReady (#89). The recovering
  // crisis floor zeroes everything (the recovery worker takes the spawn first). The dying-incumbent +1
  // is balanced by its relief in assignedCreeps, so exactly one relief is ordered per dying source.
  desiredCount() {
    if (this.colony.health.recovering) return 0;
    const safe = this.safeSources();
    const safeKeys = new Set(safe.map(key));
    const onSafe = this.assignedCreeps.filter(
      (c) => c.memory.remoteSource && safeKeys.has(key(c.memory.remoteSource))
    );
    const covered = new Set(onSafe.map((c) => key(c.memory.remoteSource))).size;
    const dying = onSafe.filter((c) => this.isDying(c)).length;
    const sustain = covered + dying; // staff active sources + pre-spawn JIT relief — unconditional
    if (!this.colony.health.expansionReady) return sustain;
    return sustain + (safe.length - covered); // + open the uncovered safe sources (expansion)
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
