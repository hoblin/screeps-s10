import { Overlord } from "./Overlord.js";
import { Worker } from "../roles/Worker.js";
import { behaviorClass } from "../behaviors/index.js";

// Builder-count tuning (#81). One builder per this many sites, floored so a
// backlog is never under-staffed and capped so we don't overspawn — the rich cap
// only applies when there's surplus energy to feed the extra hands.
const SITES_PER_BUILDER = 3;
const IDLE_BUILDERS = 2; // no backlog: keep a couple for repair / upgrade help
const MIN_BUILDERS = 3; // floor while any site exists (the old constant)
const MAX_BUILDERS_RICH = 6; // ceiling when energy is going to waste

// General-purpose builders/repairers/fillers. The conduct lives in the `work` behaviour (a thin
// Worker runs the BehaviorMachine, #239); this overlord sizes the fleet AND owns build-target
// ASSIGNMENT — it concentrates the whole builder fleet on the right site (the command pattern,
// mirroring RemoteLogisticsOverlord → haulTarget) instead of each worker self-selecting.
export class WorkOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 2 });
  }

  get role() {
    return "worker";
  }

  // Builder headcount scales with the construction backlog, but only pushes past
  // the lean cap when energy is going to waste (#81 RoomHealthCheck.energyRich) —
  // otherwise we'd spawn builders we can't feed. With no surplus this is exactly
  // the old behaviour: 3 while building, 2 idle.
  desiredCount() {
    const { buildBacklog, energyRich } = this.colony.health;
    if (buildBacklog === 0) return IDLE_BUILDERS;
    const scaled = Math.ceil(buildBacklog / SITES_PER_BUILDER);
    const cap = energyRich ? MAX_BUILDERS_RICH : MIN_BUILDERS;
    return Math.min(Math.max(scaled, MIN_BUILDERS), cap);
  }

  // The body is the model's (the `work` behaviour owns it); read it off the default node.
  bodyFor(energyBudget) {
    return behaviorClass(Worker.behaviors.default).bodyFor(energyBudget);
  }

  // Stamp the conduct set at birth so the BehaviorMachine drives the worker (mirrors RemoteHauler).
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (req) req.memory.behaviors = Worker.behaviors;
    return req;
  }

  // Assign build targets fleet-wide BEFORE driving the creeps, so each Build atom sees a fresh
  // memory.buildTarget the same tick.
  run() {
    this.assignBuildTargets();
    super.run();
  }

  // Fleet-level build-target assignment (#239) — the command pattern. The overlord owns site
  // SELECTION (tier order + concentration) and stamps each worker's memory.buildTarget; the Build
  // atom only executes it. Per-trip latch (#86): a worker keeps its site while it's still a leader,
  // so there's no per-tick re-pick (the oscillation #86 fixed for haulers). Selection ignores
  // creeps (#63), so a worker clustered away from the site is still assigned one (travelTo routes in).
  assignBuildTargets() {
    const workers = this.assignedCreeps.filter((c) => !c.spawning);
    if (!workers.length) return;
    const sites = this.colony.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (!sites.length) {
      for (const c of workers) if (c.memory.buildTarget) c.memory.buildTarget = null;
      return;
    }
    const leaders = this.buildLeaders(sites);
    const leaderIds = new Set(leaders.map((s) => s.id));
    for (const c of workers) {
      if (c.memory.buildTarget && leaderIds.has(c.memory.buildTarget)) continue; // latch: still a leader
      const site = c.pos.findClosestByPath(leaders, { ignoreCreeps: true });
      c.memory.buildTarget = site ? site.id : null;
    }
  }

  // The sites worth building NOW: the most-advanced sites within the highest-priority non-empty
  // tier (containers > other structural > roads — #72 containers gate hauling, #14 roads last), with
  // ~10 build-actions of epsilon slack so a fresh batch (all near 0) stays a flat pool chosen by
  // distance, and only a site that pulls a clear lead becomes the magnet the whole fleet converges
  // on (#33). Lifted from the per-creep Worker.selectBuildTarget so ONE decision concentrates the fleet.
  // SPAWN sites are excluded — they're the top-priority BuildSpawn atom's job (built before everything,
  // even filling), and singular, so they need no fleet concentration.
  buildLeaders(sites) {
    const epsilon = BUILD_POWER * 10;
    const buildable = sites.filter((s) => s.structureType !== STRUCTURE_SPAWN);
    if (!buildable.length) return [];
    const containers = [];
    const structural = [];
    const roads = [];
    for (const s of buildable) {
      if (s.structureType === STRUCTURE_CONTAINER) containers.push(s);
      else if (s.structureType === STRUCTURE_ROAD) roads.push(s);
      else structural.push(s);
    }
    const pool = [containers, structural, roads].find((tier) => tier.length) || buildable;
    const maxProgress = Math.max(...pool.map((s) => s.progress));
    return pool.filter((s) => s.progress >= maxProgress - epsilon);
  }

  runCreep(creep) {
    Worker.run(creep, this.colony);
  }
}
