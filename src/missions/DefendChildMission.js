import { GarrisonMission } from "./GarrisonMission.js";
import { DEFENSE_BEHAVIORS } from "./Mission.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  DefendChildMission (#259, folds in #241) — guard a founded child colony until it can defend itself.
//  PROACTIVE standing guard: recognised even when the child is NOT hot (a default body holds it), so a
//  raid lands on a present defender rather than an empty room (Robalian razed E12S5's first spawn before a
//  guard could arrive). When the child IS hot, size the counter to the threat and winnable-gate it (don't
//  feed an army). Released at RCL3 — by then the child's own towers defend it. Only the founder colony
//  guards its child, only while we still own it and it has no tower of its own.
// ============================================================================
export class DefendChildMission extends GarrisonMission {
  static autoMissions(colony) {
    const t = Memory.expansion?.claimTarget;
    if (!t?.room || !t.controller) return [];
    if ((t.home || colony.name) !== colony.name) return []; // only the founder guards its child
    const child = t.room;
    if (child === colony.name) return [];
    const room = Game.rooms[child];
    if (!room?.controller?.my) return []; // we must own it (needs live vision)
    if (room.controller.level >= 3) return []; // #241: release at RCL3 — its own towers defend it now
    const ownTower = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
    if (ownTower.length) return []; // it self-defends already

    const mission = new DefendChildMission(colony, child);
    if (!Threat.isHot(child)) return [mission]; // #241: cold proactive standing guard (default body, count 1)
    if (!Threat.killableProfile(child)) return []; // hot but nothing guard-killable
    // count > 0 means a counter group within the cap wins; 0 means even a capped group loses → don't feed.
    return mission.roster()[0].count > 0 ? [mission] : [];
  }

  constructor(colony, room) {
    super(colony, room);
    this.type = "defend-child";
  }

  // Cold child → profileFor is null → counterRoster yields the default body, count 1 (proactive). Hot child
  // → the killable profile sizes the counter.
  roster() {
    return this.counterRoster(Threat.profileFor(this.room), DEFENSE_BEHAVIORS);
  }
}
