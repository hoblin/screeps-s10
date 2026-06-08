import { Mission } from "./Mission.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteMission (#259) — the REMOTE-operation stage-shape: muster the full roster at home (replace freely
//  there — it is cheap), then deploy as ONE group and do NOT replace mid-flight (a lone reinforcement just
//  walks into a corpse). The policy rule is "replace while home, commit when it leaves"; a wipe is re-
//  emitted by the recogniser, never trickled. Home defence preempts — a unit sits home while home is hot.
//  Concrete remote missions (BustCore, ClearRemote) supply only composition + recognition.
// ============================================================================
export class RemoteMission extends Mission {
  // Spawning is open only while the group is still home (no member committed yet) — losses refill cheaply
  // during muster; once any member has launched, casualties are not replaced.
  canSpawn(members) {
    return !members.some((creep) => creep.memory.launched);
  }

  // Muster at home until the full roster is ready (rallied), then LAUNCH and steer the group to the remote.
  // launched latches on the creep so a later loss never yanks survivors back to rally; home defence preempts.
  drive(members) {
    const rallied = this.rallied(members);
    for (const creep of members) {
      if (rallied) creep.memory.launched = true;
      const advance = creep.memory.launched && !Threat.isHot(this.home);
      creep.memory.target = advance ? this.room : this.home;
    }
  }
}
