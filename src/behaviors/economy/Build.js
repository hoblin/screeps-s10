import { Behavior } from "../Behavior.js";

// ============================================================================
//  Build (#239) — economy atom: build the construction site the WorkOverlord assigned.
//  COMMAND PATTERN (like RemoteHaul): the overlord owns site SELECTION (tier order +
//  fleet concentration, #33/#72/#14) and stamps creep.memory.buildTarget = <site id>; this
//  atom only EXECUTES it — it never searches for a site itself. Returns false when there's
//  no assignment, or the assigned site has completed/vanished (clearing the stale latch so
//  the overlord re-assigns next tick), so the work `fallback` falls through to repair/upgrade.
// ============================================================================
export class Build extends Behavior {
  static run(creep, _colony) {
    const id = creep.memory.buildTarget;
    if (!id) return false;
    const site = Game.getObjectById(id);
    if (!site) {
      creep.memory.buildTarget = null; // built or removed — drop the latch; the overlord reassigns
      return false;
    }
    this.note(creep, "work:build");
    if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
    return true;
  }
}
