import { Behavior } from "../Behavior.js";
import { Role } from "../../roles/Role.js";
import { stageAtLeast } from "../../lib/Stages.js";

// ============================================================================
//  FillStructures (#239) — economy atom: top up spawns & extensions so the colony can
//  keep spawning. Pre-2b the worker IS the filler; from 2b on dedicated haulers own it,
//  so this self-gates OFF — UNLESS every hauler is dead (#37 survival fallback), when the
//  worker must refill or the colony spirals to extinction. Returns false when it doesn't
//  act (gate off, or nothing to fill) so the work `fallback` moves on to build/repair/upgrade.
//
//  Latched (committedTarget) so a worker commits to one sink until it's full, then re-picks —
//  no rotating between extensions mid-transit; travelTo keeps its cached path to the stable
//  target. Selection passes `ignoreCreeps:true` (#63) so a clustered worker WITH energy still
//  fills instead of concluding "nothing reachable" and idling.
//
//  COLONY-OPTIONAL (#242): a pioneer serving a bootstrapping child has no served-colony context
//  (colony null) — that room has no haulers and no stage, so the hand-off gate is skipped and the
//  pioneer always fills creep.room's spawn/extensions (the cold-start lifeline). Everything below
//  is already creep.room-scoped (FIND_MY_STRUCTURES), so it serves both tenants unchanged.
// ============================================================================
export class FillStructures extends Behavior {
  static run(creep, colony) {
    // Hand-off doctrine: from 2b on, haulers fill — but only while a FILL-CAPABLE one is alive (#37).
    // A still-spawning hauler can't fill yet, so it must NOT gate the worker off (else the spawn starves
    // through the hauler's whole spawn window). Mirrors the non-spawning check in Role.gatherEnergy.
    // No served colony (a pioneer): no haulers exist there, so never gate off — always fill.
    if (colony) {
      const haulerCanFill = colony.creepsWithRole("hauler").some((h) => !h.spawning);
      if (stageAtLeast(colony, "2b:Hauling") && haulerCanFill) return false;
    }

    const fillable = (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    const target = Role.committedTarget(creep, "fillTarget", fillable, () =>
      creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { ignoreCreeps: true, filter: fillable })
    );
    if (!target) return false;

    this.note(creep, "work:fill");
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(target);
    return true;
  }
}
