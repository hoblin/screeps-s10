import { Behavior } from "../Behavior.js";
import { travelToRoom } from "./atoms/acts.js";

// ============================================================================
//  RoamNeighbour (#187) — the sweep leg of freeHunter: with nothing to fight here, patrol the
//  colony's protected remotes in turn so an idle combat unit denies the whole footprint instead
//  of standing on one tile (or recycling). A cursor in memory cycles the sweep set; on arrival at
//  the current target it advances to the next. Transit is danger-aware (skips hot/towered corridors
//  via travelToRoom) — a roamer never walks blind into a tower or an Invader room.
//
//  The sweep set is the colony's remote-mining rooms (the economy worth screening). A remote with no
//  safe corridor right now is skipped to the next — the cursor moves on rather than the unit stalling.
//  Returns true (it always handles the tick: a leg walked, or — single-remote / all-unreachable — it
//  holds in place, where freeHunter's engage still kills anything that wanders in).
// ============================================================================
export class RoamNeighbour extends Behavior {
  static run(creep, colony) {
    const rooms = this.sweepSet(colony);
    if (!rooms.length) {
      this.note(creep, "roam:none"); // nothing to patrol (no remotes yet) → idle here
      return false;
    }
    let i = (creep.memory.roamIndex ?? 0) % rooms.length;
    if (creep.room.name === rooms[i]) i = (i + 1) % rooms.length; // arrived → advance to the next remote
    creep.memory.roamIndex = i;

    if (travelToRoom(creep, rooms[i])) {
      this.note(creep, "roam:sweep");
      return true;
    }
    // No safe corridor to this remote right now → skip it next tick, hold this tick.
    creep.memory.roamIndex = (i + 1) % rooms.length;
    this.note(creep, "roam:reroute");
    return true;
  }

  // The rooms a roamer patrols: the colony's remote-mining rooms (deduped) — the economy a free
  // hunter screens. Read live so a dropped/added remote is reflected without respawn.
  static sweepSet(colony) {
    return [...new Set(colony.remoteSources().map((s) => s.room))];
  }
}
