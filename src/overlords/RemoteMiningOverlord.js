import { Overlord } from "./Overlord.js";
import { RemoteMiner } from "../roles/RemoteMiner.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteMiningOverlord — owns the whole remote-mining domain (#18 C2, #102).
//
//  ONE controller for ALL remote sources (not one-per-source): an Overlord is a
//  stateless controller over a domain, and the stateful things — a source's tile,
//  a miner's current assignment, a room's threat — are the model (the static map,
//  creep memory, the intel overlay). Owning the domain in one place is what makes
//  cross-source decisions trivial: when a room turns hot we re-home its miners onto
//  a free safe source (or pull them back) with full visibility — no coordination
//  between per-source instances.
//
//  Allocation: one miner per safe source (reachable + not currently hot), value
//  best-first. Each miner's source is stamped in its memory (its model); the
//  controller hands out assignments on spawn and reconciles them every tick.
//  Health-gated on expansionReady (#89) — spawning a miner drops spawn-idle, so the
//  latch releases and the set fills over several ticks, best source first, never
//  beyond spare capacity. v1 drop-mines (no remote container).
// ============================================================================
const key = (s) => `${s.room}:${s.x}:${s.y}`;

export class RemoteMiningOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // singleton: priority after the home economy
  }

  get role() {
    return "remoteMiner";
  }

  // The domain's current target set: every mineable remote source whose room isn't
  // contested right now (#105). Value-ranked (remoteSources() already sorts).
  safeSources() {
    return this.colony.remoteSources().filter((s) => !Threat.isHot(s.room));
  }

  // One miner per safe source, once the home economy can invest (#89).
  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.safeSources().length;
  }

  bodyFor(energyBudget) {
    return RemoteMiner.bodyFor(energyBudget);
  }

  // Stamp the source a new miner should take: the best safe source no miner covers
  // yet (the controller owns allocation; the creep just carries the assignment).
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (!req) return null;
    const covered = this.coveredSources();
    const s = this.safeSources().find((src) => !covered.has(key(src)));
    if (!s) return null; // every safe source already has a miner
    req.memory.remoteSource = { room: s.room, x: s.x, y: s.y, dist: s.dist };
    return req;
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
