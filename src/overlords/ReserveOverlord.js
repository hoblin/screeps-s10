import { Overlord } from "./Overlord.js";
import { Reserver } from "../roles/Reserver.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  ReserveOverlord — reserves ONE remote room (#18 C1, generalised in #102).
//
//  One instance per distinct remote room that has ≥1 mined source (Colony builds
//  them from remoteSources()). A room needs a single reserver no matter how many of
//  its sources we tap, so this is keyed per-ROOM, not per-source. Reserving (NOT
//  claiming — zero GCL cost) boosts that room's sources from 1500/300 to 3000/300.
//
//  Prepared-in-advance, HEALTH-triggered (not stage-gated): 0 reservers until the
//  home economy has spare capacity (health.expansionReady, #89) AND the room isn't
//  currently contested (Threat.isHot, #105). expansionReady self-throttles the
//  whole expansion set. The map already excluded Source-Keeper and enemy rooms; the
//  Reserver role does the live hostile check on arrival.
// ============================================================================
export class ReserveOverlord extends Overlord {
  constructor(colony, target) {
    // Key on the room name: one reserver per room, identifier "reserver:E16S7".
    super(colony, { priority: 5, instanceId: target.room });
    this.target = target; // { room, controller: {x,y} }
  }

  get role() {
    return "reserver";
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    if (Threat.isHot(this.target.room)) return 0; // contested — don't feed a reserver in
    return 1;
  }

  bodyFor(energyBudget) {
    return Reserver.bodyFor(energyBudget);
  }

  // Stamp the room + controller tile this reserver serves on top of the base
  // ownership tags, so it binds to THIS room (with many remotes the role can't read
  // "the" target live). Threat re-routing: desiredCount stops spawning for a hot
  // room, and an out reserver retreats (reading the shared intel #105).
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (req) {
      req.memory.reserveRoom = { room: this.target.room, controller: this.target.controller };
    }
    return req;
  }

  runCreep(creep) {
    Reserver.run(creep, this.colony);
  }
}
