import { Overlord } from "./Overlord.js";
import { Worker } from "../roles/Worker.js";
import { behaviorClass } from "../behaviors/index.js";
import { assignBuildTargets } from "./buildTargets.js";

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
  // memory.buildTarget the same tick. The concentration policy is the shared command-pattern helper
  // (assignBuildTargets) — we own only WHICH sites (this colony's home room); it owns HOW the fleet
  // divides among them, the same policy ClaimOverlord reuses over a bootstrapping child (#242).
  run() {
    const workers = this.assignedCreeps.filter((c) => !c.spawning);
    assignBuildTargets(workers, this.colony.room.find(FIND_MY_CONSTRUCTION_SITES));
    super.run();
  }

  runCreep(creep) {
    Worker.run(creep, this.colony);
  }
}
