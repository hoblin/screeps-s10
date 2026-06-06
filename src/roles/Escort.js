import { Role } from "./Role.js";
import { Engage } from "../behaviors/combat/Engage.js";

// ============================================================================
//  Escort — a guard that bodyguards a scout to clear a persistent harasser blocking a
//  valuable room (#147). A dumb FOLLOW-role: each tick it travels to its assigned scout;
//  when a hostile is in the room it switches to combat (the shared Engage atom, #189 —
//  no longer reaching into the Guard role). If the scout is gone (died / recycled), it
//  recycles too.
//
//  NOTE: the follow/bait coupling is being replaced — #187 rebuilds the escort as a pure
//  behavior composition (travelToRoom→engage→hold, no scout-follow). This is the minimal
//  rewire to drop the Guard dependency in the meantime.
// ============================================================================
export class Escort extends Role {
  static movementPriority = 3; // matches the old Guard-derived priority (above idle/work, below haul/mine)

  static run(creep, colony) {
    const scout = Game.creeps[creep.memory.escortScout];
    if (!scout) return this.recycleAtHome(creep, colony); // no scout to guard → go home

    // Combat takes priority over following: fight any hostiles where we are (this clears the
    // blocker); otherwise tail the scout.
    if (Engage.run(creep, colony)) return;
    this.note(creep, "escort:follow");
    creep.travelTo(scout, { range: 1 });
  }
}
