import { Behavior } from "../Behavior.js";
import { Role } from "../../roles/Role.js";

// ============================================================================
//  BuildSpawn (#239) — economy atom: build a SPAWN construction site, the colony's single most
//  critical structure. FIRST in the work chain (above even fill): a colony with no spawn can't
//  produce creeps, so a rebuilding/recovering colony pours every worker onto the spawn before
//  touching anything else (the user's priority: build spawn → fill spawn → build the rest). The
//  spawn is a SINGULAR target (no fleet-concentration problem — workers converge on the one site
//  naturally), so unlike the bulk build it self-scans rather than waiting on an overlord assignment.
//  Returns false when no spawn site exists, so in normal operation (spawn long since built) it's a
//  no-op and the chain falls through to fill/build/repair/upgrade.
//
//  Latched (committedTarget) + ignoreCreeps selection (#63) so a worker commits to the spawn site
//  and doesn't rotate or stall mid-transit when creeps cluster around it.
// ============================================================================
export class BuildSpawn extends Behavior {
  static run(creep, _colony) {
    const site = Role.committedTarget(
      creep,
      "spawnSite",
      () => true, // a construction site is valid as long as it exists (getObjectById returns null once built)
      () =>
        creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES, {
          ignoreCreeps: true,
          filter: (s) => s.structureType === STRUCTURE_SPAWN,
        })
    );
    if (!site) return false;

    this.note(creep, "work:build-spawn");
    if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
    return true;
  }
}
