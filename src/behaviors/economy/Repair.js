import { Behavior } from "../Behavior.js";
import { Role } from "../../roles/Role.js";

// ============================================================================
//  Repair (#239) — economy atom: repair the nearest damaged structure (skipping walls and
//  ramparts, which are a defensive concern, not general upkeep). Self-gates — returns false
//  when nothing needs repair, so the work `fallback` moves on to upgrade.
//
//  Latched (committedTarget) so a worker commits to one structure until it's back to full
//  hits, then re-picks — repair is a long, many-tick task, so without the latch a worker would
//  re-target and re-path every tick. Selection passes `ignoreCreeps:true` (#63).
// ============================================================================
export class Repair extends Behavior {
  static run(creep, _colony) {
    const damaged = (s) =>
      s.hits < s.hitsMax &&
      s.structureType !== STRUCTURE_WALL &&
      s.structureType !== STRUCTURE_RAMPART;
    const target = Role.committedTarget(creep, "repairTarget", damaged, () =>
      creep.pos.findClosestByPath(FIND_STRUCTURES, { ignoreCreeps: true, filter: damaged })
    );
    if (!target) return false;

    this.note(creep, "work:repair");
    if (creep.repair(target) === ERR_NOT_IN_RANGE) creep.travelTo(target);
    return true;
  }
}
