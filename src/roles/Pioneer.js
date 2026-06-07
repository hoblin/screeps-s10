import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { routeToRoom } from "../lib/Transit.js";

// ============================================================================
//  Pioneer — bootstraps a freshly-claimed 2nd colony (#220).
//
//  The second half of the expansion directive. A claimed room is inert: a
//  controller but no spawn, no creeps, no energy. Pioneers are WORK+CARRY+MOVE
//  generalists spawned from the MAIN colony that travel danger-aware to the new
//  room, self-harvest its sources, and BUILD its first spawn (the site the new
//  Colony's SpawnPlanner places). Once that spawn stands, the room spawns its own
//  miners/workers (Stage-1 bootstrap) and ClaimOverlord stops the pioneer stream —
//  so pioneers are a finite seed crew, not a standing supply line.
//
//  Grouped under the HOME colony (memory.colony = home) so the home Hatchery builds
//  them and ClaimOverlord drives them; the room they SERVE is stamped separately
//  (memory.bootstrapRoom). They operate entirely on creep.room (the target).
// ============================================================================
export class Pioneer extends Role {
  // Build/seed work — interruptible, yields to logistics like a worker.
  static movementPriority = 3;

  // Route around hostile kill-zones on the long haul to the target (#145).
  static avoidHostiles = true;

  // A balanced generalist (harvest + haul + build), scaled evenly so a richer home
  // sends a beefier seed that builds the first spawn faster.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, CARRY, MOVE], {
      extra: [WORK, CARRY, MOVE],
      max: 4,
      energy: energyBudget,
    });
  }

  static run(creep, colony) {
    const targetRoom = creep.memory.bootstrapRoom;
    if (!targetRoom) return this.recycleAtHome(creep, colony);

    // SK-safe, swamp-aware engine transit (#225): one committed trip toward the target, routing
    // around SK/towered/hot rooms, with a scoutThreat bump on damage so the hunter clears a blocker.
    if (routeToRoom(creep, targetRoom)) {
      this.note(creep, "pioneer:to-room");
      return;
    }
    if (creep.room.name !== targetRoom) return; // trapped en route — idle this tick

    // In the target room, act as a self-sufficient bootstrap worker on the LOCAL
    // room. gatherEnergy with no colony self-harvests (the pre-spawn lifeline this
    // empty room needs — there are no containers to draw from yet).
    const working = Role.updateWorkingState(creep);
    if (!working) {
      this.note(creep, "pioneer:gather");
      this.gatherEnergy(creep, null);
      return;
    }

    // 1. Build the SPAWN first — it's the whole point of the seed (Stage 0 Founding, #228). Until it
    //    stands the colony can't spawn for itself, so it outranks every other site (a stray container/
    //    road must never win on mere proximity). Fall back to the nearest site once no spawn site remains.
    const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length) {
      const spawnSite = sites.find((s) => s.structureType === STRUCTURE_SPAWN);
      const site = spawnSite || creep.pos.findClosestByPath(sites) || sites[0];
      this.note(creep, "pioneer:build");
      if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
      return;
    }

    // 2. Spawn built but starving: a PLAYER-built spawn starts with zero energy (unlike
    //    the gift-energized season starting spawn), so the new colony can't make its
    //    first creep until something primes it. Pour energy in until it spawns for itself.
    const spawn = creep.room
      .find(FIND_MY_SPAWNS)
      .find((s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (spawn) {
      this.note(creep, "pioneer:fill");
      if (creep.transfer(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(spawn);
      return;
    }

    // 3. Nothing to build or fill — keep the controller alive by upgrading so a slow
    //    bootstrap never lets it downgrade.
    const controller = creep.room.controller;
    this.note(creep, "pioneer:upgrade");
    if (controller && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      creep.travelTo(controller, { range: 3 });
    }
  }
}
