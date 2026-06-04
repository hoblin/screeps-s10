import { Overlord } from "./Overlord.js";
import { Worker } from "../roles/Worker.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// Builder-count tuning (#81). One builder per this many sites, floored so a
// backlog is never under-staffed and capped so we don't overspawn — the rich cap
// only applies when there's surplus energy to feed the extra hands.
const SITES_PER_BUILDER = 3;
const IDLE_BUILDERS = 2; // no backlog: keep a couple for repair / upgrade help
const MIN_BUILDERS = 3; // floor while any site exists (the old constant)
const MAX_BUILDERS_RICH = 6; // ceiling when energy is going to waste

// General-purpose builders/repairers/fillers. Fills spawn+extensions first,
// then builds construction sites, then repairs, else helps upgrade.
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

  bodyFor(energy) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 5, energy });
  }

  runCreep(creep) {
    Worker.run(creep, this.colony);
  }
}
