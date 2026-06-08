import { Mission } from "./Mission.js";

// ============================================================================
//  GarrisonMission (#259) — the HOME/CHILD-defence stage-shape: the group is permanently "home" (the
//  defended room IS the spawn-adjacent post), so its muster stage never closes — losses are replaced
//  continuously (the survival floor) — and it executes in place, never recalled. A defender holds the
//  room and engages intruders there; once the room cools and the mission de-recognises, the overlord's
//  resolve stage either sends a victorious defender to retaliate or recalls it home.
// ============================================================================
export class GarrisonMission extends Mission {
  // Replace losses continuously while the threat stands — a garrison must not thin out under fire.
  canSpawn() {
    return true;
  }

  // Hold the defended room (engage intruders in place). No deploy phase — the post is home-adjacent.
  drive(members) {
    for (const creep of members) creep.memory.target = this.room;
  }
}
