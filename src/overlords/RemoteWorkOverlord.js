import { Overlord } from "./Overlord.js";
import { RemoteWorker } from "../roles/RemoteWorker.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteWorkOverlord — owns the remote-container-infrastructure domain (#114).
//
//  ONE controller for ALL remote source containers (mirrors RemoteMiningOverlord /
//  ReserveOverlord / RemoteLogisticsOverlord). It keeps one container alive under
//  each remote source we mine: build where missing, repair the most-damaged.
//
//  It reads container STATE from a shared per-source cache the miner publishes
//  (Memory.colonyData[...].remoteContainers) — the miner is permanently parked on
//  the tile, so it's the continuous sensor; this overlord is the controller that
//  turns that state into assignments, and RemoteWorker is the actuator. So the
//  overlord needs no vision of its own: a source only becomes "needy" once a miner
//  has established its room (cache entry exists), which also means a worker is never
//  spawned ahead of production. Health-gated on expansionReady; hot rooms drop out.
// ============================================================================
const key = (s) => `${s.room}:${s.x}:${s.y}`;
const REPAIR_BELOW = 0.5; // repair a remote container once it falls under half hits

export class RemoteWorkOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // singleton: after the home economy
  }

  get role() {
    return "remoteWorker";
  }

  remoteContainers() {
    return Memory.colonyData?.[this.colony.name]?.remoteContainers || {};
  }

  // Remote sources needing work right now, prioritised: BUILD (no container yet)
  // before REPAIR (damaged), most-damaged first. A source qualifies only if it's
  // currently MINED (a live miner is assigned — no point building a container at a
  // source nobody fills, and this also drops stale cache after a miner re-homes) and
  // the room is safe.
  needyWork() {
    const cont = this.remoteContainers();
    const mined = new Set(
      this.colony.creepsWithRole("remoteMiner").map((c) => c.memory.remoteSource).filter(Boolean).map(key)
    );
    const work = [];
    for (const s of this.colony.remoteSources()) {
      if (Threat.isHot(s.room) || !mined.has(key(s))) continue;
      const c = cont[key(s)];
      if (!c) continue; // miner assigned but not parked yet → tile/state unknown
      if (c.hits == null) work.push({ s, build: true, hits: 0 });
      else if (c.hits < c.hitsMax * REPAIR_BELOW) work.push({ s, build: false, hits: c.hits });
    }
    work.sort((a, b) => (a.build !== b.build ? (a.build ? -1 : 1) : a.hits - b.hits));
    return work;
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.needyWork().length; // one worker per needy source; 0 when all healthy
  }

  bodyFor(energyBudget) {
    return RemoteWorker.bodyFor(energyBudget);
  }

  coveredKeys() {
    return new Set(
      this.assignedCreeps.map((c) => c.memory.remoteSource).filter(Boolean).map(key)
    );
  }

  // Stamp the highest-priority needy source no worker covers yet.
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (!req) return null;
    const covered = this.coveredKeys();
    const task = this.needyWork().find((w) => !covered.has(key(w.s)));
    if (!task) return null;
    req.memory.remoteSource = { room: task.s.room, x: task.s.x, y: task.s.y };
    return req;
  }

  // Reconcile each tick (same shape as RemoteMiningOverlord): keep workers on needy
  // sources; re-home a worker off a now-healthy/hot source onto a free needy one;
  // recycle when there's no work left (its source is built + healthy).
  run() {
    const needy = this.needyWork();
    const needyKeys = new Set(needy.map((w) => key(w.s)));
    const covered = new Set(
      this.assignedCreeps
        .map((c) => c.memory.remoteSource)
        .filter((a) => a && needyKeys.has(key(a)))
        .map(key)
    );
    for (const creep of this.assignedCreeps) {
      const a = creep.memory.remoteSource;
      if (a && needyKeys.has(key(a))) continue; // still has work
      const free = needy.find((w) => !covered.has(key(w.s)));
      if (free) {
        creep.memory.remoteSource = { room: free.s.room, x: free.s.x, y: free.s.y };
        covered.add(key(free.s));
      } else {
        creep.memory.remoteSource = null; // no work → role recycles it
      }
    }
    super.run();
  }

  runCreep(creep) {
    RemoteWorker.run(creep, this.colony);
  }
}
