import { RemoteMission } from "./RemoteMission.js";
import { DEFENSE_BEHAVIORS } from "./Mission.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  ClearRemoteMission (#259) — clear a mobile invader squatting one of our remotes so mining resumes. A
//  RemoteMission: muster the counter at home, deploy, engage. Recognised only for a hot remote with a
//  guard-killable threat we can WIN (the winnable gate — don't feed a losing fight; pull the remote and
//  wait instead). Ported from GuardOverlord's hotWinnableRooms (the remote tier of the priority ladder).
// ============================================================================
export class ClearRemoteMission extends RemoteMission {
  static autoMissions(colony) {
    const rooms = [...new Set(colony.remoteSources().map((s) => s.room))];
    return rooms
      .filter((room) => Threat.isHot(room) && Threat.killableProfile(room))
      .map((room) => new ClearRemoteMission(colony, room))
      .filter((mission) => mission.roster()[0].count > 0); // a counter group within the cap can win; else don't feed
  }

  constructor(colony, room) {
    super(colony, room);
    this.type = "clear-remote";
  }

  roster() {
    return this.counterRoster(Threat.profileFor(this.room), DEFENSE_BEHAVIORS);
  }
}
