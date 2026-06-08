import { RemoteMission } from "./RemoteMission.js";
import { DEFENSE_BEHAVIORS } from "./Mission.js";
import { Threat } from "../lib/Threat.js";
import { combatBody } from "../lib/CombatBody.js";

// ============================================================================
//  ClearRemoteMission (#259) — clear a mobile invader squatting one of our remotes so mining resumes. A
//  RemoteMission: muster the counter at home, deploy, engage. Recognised only for a hot remote with a
//  guard-killable threat we can WIN (the winnable gate — don't feed a losing fight; pull the remote and
//  wait instead). Ported from GuardOverlord's hotWinnableRooms (the remote tier of the priority ladder).
// ============================================================================
export class ClearRemoteMission extends RemoteMission {
  static autoMissions(colony) {
    const budget = colony.spawnEnergyBudget();
    const rooms = [...new Set(colony.remoteSources().map((s) => s.room))];
    return rooms
      .filter((room) => {
        if (!Threat.isHot(room) || !Threat.killableProfile(room)) return false;
        const body = combatBody(budget, Threat.profileFor(room));
        return Threat.guardCombatPower(body) > 0 && Threat.winnable(body, room);
      })
      .map((room) => new ClearRemoteMission(colony, room));
  }

  constructor(colony, room) {
    super(colony, room);
    this.type = "clear-remote";
  }

  roster() {
    return this.counterRoster(Threat.profileFor(this.room), DEFENSE_BEHAVIORS);
  }
}
