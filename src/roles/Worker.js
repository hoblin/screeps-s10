import { Role } from "./Role.js";
import { stageAtLeast } from "../lib/Stages.js";

// Build-progress tolerance (#33): sites within this many points of the leader
// count as "tied" and are chosen by distance, not progress. ~10 build actions'
// worth of slack — below it the lead is too small to justify a cross-base trek;
// above it one site has pulled clearly ahead and every worker converges on it.
// Read BUILD_POWER lazily (inside the function) so merely importing this module
// doesn't depend on the Screeps global — keeps it safe to bundle/unit-test.

// Worker: priority chain — fill spawn/extensions > build > repair > upgrade.
// Once haulers are active (2b:Hauling), workers STOP filling spawn/extensions
// and leave that to dedicated haulers — otherwise both race for the same
// targets, wasting trips and CPU. Workers then focus on build/repair/upgrade.
//
// Survival override (#37): the 2b hand-off assumes a hauler is alive to do the
// filling. We run a lean hauler fleet (one per source), so if they ALL die
// nobody refills the spawn and the colony spirals to extinction (can't afford a
// replacement hauler). So the fill step reactivates as an emergency fallback
// whenever zero haulers live —
// survival outranks the no-racing optimization.
export class Worker extends Role {
  // Build/repair/fill is important but interruptible — yields the tile to
  // logistics (miner/hauler), outranks pure idling.
  static movementPriority = 3;

  static run(creep, colony) {
    const working = Role.updateWorkingState(creep);

    if (!working) {
      Role.gatherEnergy(creep, colony);
      return;
    }

    // 1. Fill spawns & extensions — while haulers aren't doing it yet (pre-2b),
    //    or as an emergency fallback when no hauler is alive to do it (#37).
    const haulersAlive = colony.creepsWithRole("hauler").length > 0;
    if (!stageAtLeast(colony, "2b:Hauling") || !haulersAlive) {
      const fill = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      });
      if (fill) {
        if (creep.transfer(fill, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(fill);
        return;
      }
    }

    // 2. Build construction sites. Roads come last (below extensions and
    //    containers, above repair — issue #14): they're a throughput nicety,
    //    while extensions/containers gate energy capacity, so finish the
    //    structural sites before paving. Within a tier, concentrate effort (#33).
    const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length) {
      const site = Worker.selectBuildTarget(creep, sites);
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
        return;
      }
    }

    // 3. Repair damaged structures (skip walls/ramparts for now).
    const repair = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: (s) =>
        s.hits < s.hitsMax &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART,
    });
    if (repair) {
      if (creep.repair(repair) === ERR_NOT_IN_RANGE) creep.travelTo(repair);
      return;
    }

    // 4. Idle fallback: help upgrade.
    if (creep.upgradeController(colony.controller) === ERR_NOT_IN_RANGE) {
      creep.travelTo(colony.controller);
    }
  }

  // Pick the next construction site. Tier first — structural sites
  // (extensions/containers) before roads (#14) — then CONCENTRATE within the
  // tier (#33): build the most-advanced site so it finishes (and yields its
  // capability) first. Sites tied near the lead fall back to nearest, so a
  // fresh batch (all at 0) behaves like the old nearest-first with no cross-base
  // detours. The rule is self-reinforcing: whichever site first pulls a real
  // lead becomes the magnet that draws every worker until it completes.
  static selectBuildTarget(creep, sites) {
    const epsilon = BUILD_POWER * 10;
    const nonRoad = sites.filter((s) => s.structureType !== STRUCTURE_ROAD);
    const pool = nonRoad.length ? nonRoad : sites;
    const maxProgress = Math.max(...pool.map((s) => s.progress));
    const leaders = pool.filter((s) => s.progress >= maxProgress - epsilon);
    return creep.pos.findClosestByPath(leaders);
  }
}
