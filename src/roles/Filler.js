import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// ============================================================================
//  Filler — the storage→spawn-cluster pump (#152). The Overmind "queen/manager".
//
//  A full storage can sit one tile from an empty spawn and the colony still
//  starves: spawn + extensions are filled by HAULERS, whose fleet is sized to
//  source throughput (#84) — when that dips (rooms lost, economy crash) there
//  aren't enough hauler-trips to also top the spawn, so spawning stalls beside a
//  50k buffer. The Filler bridges that last meter: one cheap creep that withdraws
//  from storage and refills spawn + extensions, making spawn-fill independent of
//  the remote-hauler fleet. Activates once storage exists (Stage 3).
// ============================================================================
export class Filler extends Role {
  // Logistics tier (= haulers, 2): the filler does critical short trips through the dense
  // base cluster, so it must move as well as the other energy-movers and NOT be shoved aside
  // by workers/upgraders (3) — else it can't keep the spawn topped, defeating its purpose.
  // Ties with haulers/harvesters resolve without shoving; miners (1) still hold their posts.
  static movementPriority = 2;

  // A plain hauler body (CARRY+MOVE, scaled to the budget) — just like our other haulers;
  // a bigger filler refills more of the cluster per short trip. Scales to 10×CARRY (500) so one
  // filler tops a larger RCL6+ extension field in fewer trips (#248) — the count is fixed at 1, so
  // capacity is the only lever. (If it dies while the spawn is starved, the Hatchery spawns the
  // cheaper affordable requests first to trickle-fill, then this once it's affordable — no deadlock.)
  static bodyFor(energyBudget) {
    return bodyFromTemplate([CARRY, MOVE], { extra: [CARRY, MOVE], max: 9, energy: energyBudget });
  }

  static run(creep, colony) {
    const storage = colony.room.storage;

    // Empty → load from storage (or idle by the spawn if there's nothing to pump).
    if (creep.store[RESOURCE_ENERGY] === 0) {
      if (!storage || storage.store[RESOURCE_ENERGY] === 0) return this.idleBySpawn(creep, colony);
      this.note(creep, "fill:load");
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(storage, { range: 1 });
      return;
    }

    // Carrying → top up the nearest hungry spawn/extension (the colony's ability to spawn).
    const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      ignoreCreeps: true, // select as if no creeps; travelTo routes around them (#63)
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (target) {
      this.note(creep, "fill:supply");
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(target);
      return;
    }

    // Cluster full → wait by the spawn HOLDING the load, ready to top the next drain instantly.
    this.idleBySpawn(creep, colony);
  }

  // Park within reach of the spawn cluster so the next fill is one step away.
  static idleBySpawn(creep, colony) {
    this.note(creep, "fill:idle");
    const spawn = colony.spawns[0];
    if (spawn && !creep.pos.inRangeTo(spawn, 1)) creep.travelTo(spawn, { range: 1 });
  }
}
