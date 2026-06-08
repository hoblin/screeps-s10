import { GarrisonMission } from "./GarrisonMission.js";
import { DEFENSE_BEHAVIORS } from "./Mission.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  DefendHomeMission (#259) — the survival floor. Whenever home is hot with a KILLABLE threat (a mobile or
//  structural attacker, not a lone tower/core), field a counter group at home — UNCONDITIONALLY, no
//  winnability gate (we must defend home even against a superior force; the towers carry the rest). The
//  count scales to the threat (one body for a normal raid, up to the cap for a heavy one). Ported from
//  GuardOverlord's home tier (the top of the home > child > remote priority ladder).
// ============================================================================
export class DefendHomeMission extends GarrisonMission {
  static autoMissions(colony) {
    const home = colony.name;
    if (!Threat.isHot(home)) return [];
    if (!Threat.killableProfile(home)) return []; // a lone tower/core isn't guard-killable — let towers handle it
    const mission = new DefendHomeMission(colony, home);
    return mission.roster()[0].count > 0 ? [mission] : []; // affordable + armed (else skip, #234)
  }

  constructor(colony, room) {
    super(colony, room);
    this.type = "defend-home";
  }

  roster() {
    return this.counterRoster(Threat.profileFor(this.room), DEFENSE_BEHAVIORS);
  }
}
