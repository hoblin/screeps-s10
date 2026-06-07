import { Work } from "./Work.js";
import { Hauler } from "../../roles/Hauler.js";
import { routeToRoom } from "../../lib/Transit.js";
import { bodyFromTemplate } from "../../lib/BodyGenerator.js";

// ============================================================================
//  Pioneer (#242) — the bootstrap conduct: a Worker for a colony that has no workers yet. It IS the
//  #239 Work conduct (gather↔work cycle: self-harvest → build-spawn > fill > overlord-assigned build >
//  repair > upgrade-with-surplus), wrapped with a TRANSIT prefix and run on the child room instead of a
//  home colony. So the same atoms #239 lifted out of Worker now serve a remote bootstrapping room — the
//  shared-ready payoff that refactor was scoped for, with NO duplicated build/fill/upgrade logic.
//
//  This is the conduct half of the `pioneer` role (src/roles/Pioneer.js is the thin role that declares
//  `behaviors = { default: "pioneer" }` and delegates here, mirroring Worker→Work / RemoteHauler→RemoteHaul).
//
//  Two differences from Work, both encapsulated in run():
//   • TRANSIT — the creep is spawned at home and must reach the child first (swamp-/danger-aware
//     routeToRoom, #225/#227); only once arrived does the work cycle run.
//   • COLONY-OPTIONAL — there's no served-colony economy in the child yet, so we drive the cycle with a
//     NULL colony: the collect/deliver atoms (made colony-optional in #242) then operate on creep.room —
//     self-harvest the child's sources, fill ITS spawn, upgrade ITS controller.
// ============================================================================
export class Pioneer extends Work {
  // A balanced generalist (harvest + haul + build), scaled evenly so a richer home sends a beefier seed
  // that builds the first spawn faster. Capped a touch below the home worker — a finite seed crew, not a
  // standing fleet. (Overrides Work's body; the model owns its body, ClaimOverlord reads it off here.)
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 4, energy: energyBudget });
  }

  static run(creep, _colony) {
    const targetRoom = creep.memory.bootstrapRoom;
    if (!targetRoom) return; // unassigned — the role's lifecycle guard handles orphans (recycle home)

    // SK-safe, swamp-aware engine transit (#225/#227): one committed trip toward the child, routing
    // around SK/towered/hot rooms. Returns true while travelling — hold off the work cycle until arrived.
    if (routeToRoom(creep, targetRoom)) {
      this.note(creep, "pioneer:to-room");
      return;
    }
    if (creep.room.name !== targetRoom) {
      this.note(creep, "pioneer:no-route"); // trapped en route (no safe corridor) — idle this tick
      return;
    }

    // Arrived: run the shared Work gather↔work cycle on the LOCAL (child) room. NULL colony, so the
    // colony-optional atoms target creep.room throughout — the cold-start lifeline an empty room needs.
    Hauler.runCycle(creep, null, this);
  }
}
