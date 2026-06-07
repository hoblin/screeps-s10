import { Role } from "./Role.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteWorker — builds + maintains the container under a remote source (#114).
//
//  The remote analogue of the home Worker, but scoped to ONE assigned remote
//  source's container (the miner drop-mines onto a fixed tile; a container there
//  banks the energy with zero decay and gives haulers one withdraw point). A dumb
//  executor per the domain-controller doctrine: RemoteWorkOverlord decides WHICH
//  source needs build/repair and stamps it; this role just gathers energy in the
//  remote room (the miner's drop pile, co-located so no home round-trip) and
//  builds the container site, then repairs the container.
//
//  The container tile is the miner's parking tile — the miner publishes it (and the
//  container's live hits) into Memory.colonyData[...].remoteContainers, so the
//  worker and the overlord share one source of truth. No assignment → recycle; room
//  unsafe FOR THE ECONOMY → hold home (Threat.isHotForEconomy, #150 — netted by our force
//  present, so it keeps working while a guard holds the room).
// ============================================================================
export class RemoteWorker extends Role {
  // Below haulers: building a remote container is never more urgent than moving the
  // colony's energy, but it still works, so above idle roles.
  static movementPriority = 4;

  // Detour around hostile ranged kill-zones en route to the remote container (#145).
  static avoidHostiles = true;

  // WORK to build/repair + CARRY to fuel it + MOVE for the cross-border trip. Scales to 6×WORK
  // (1200e) so a remote container (250k hits) builds/repairs faster over the long haul (#248) instead
  // of stalling at 4 WORK; one per source, so capacity is the throughput lever.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 5, energy: energyBudget });
  }

  static run(creep, colony) {
    const target = creep.memory.remoteSource; // { room, x, y } stamped by the overlord
    if (!target) {
      // No assignment → the controller has no remote container work for it. Recycle.
      return this.recycleAtHome(creep, colony);
    }
    if (Threat.isHotForEconomy(target.room)) {
      this.note(creep, "rwork:hot");
      return this.retreatHome(creep, colony);
    }

    const working = Role.updateWorkingState(creep);
    if (!working) {
      this.note(creep, "rwork:gather");
      return this.gather(creep, target);
    }

    // Spending: must be in the remote room to build/repair.
    if (creep.room.name !== target.room) {
      this.note(creep, "rwork:to-room");
      creep.travelTo(new RoomPosition(target.x, target.y, target.room), { range: 1 });
      return;
    }

    // The container tile = the miner's parking tile, published per source by the miner.
    const cached = Memory.colonyData?.[colony.name]?.remoteContainers?.[`${target.room}:${target.x}:${target.y}`];
    if (!cached) {
      // The miner hasn't established the tile yet — wait by the source.
      this.note(creep, "rwork:wait");
      creep.travelTo(new RoomPosition(target.x, target.y, target.room), { range: 1 });
      return;
    }
    const tile = new RoomPosition(cached.x, cached.y, target.room);

    // Place the site if missing (idempotent), build it, else repair the container.
    ContainerPlanner.ensureSite(creep.room, tile, "remote-source");
    const site = tile.lookFor(LOOK_CONSTRUCTION_SITES).find((s) => s.structureType === STRUCTURE_CONTAINER);
    if (site) {
      this.note(creep, "rwork:build");
      if (creep.build(site) === ERR_NOT_IN_RANGE) creep.travelTo(site);
      return;
    }
    const container = tile.lookFor(LOOK_STRUCTURES).find((s) => s.structureType === STRUCTURE_CONTAINER);
    if (container && container.hits < container.hitsMax) {
      this.note(creep, "rwork:repair");
      if (creep.repair(container) === ERR_NOT_IN_RANGE) creep.travelTo(container);
      return;
    }
    // Built and healthy — nothing to do; the overlord recycles/reassigns next tick.
    this.note(creep, "rwork:idle");
  }

  // Gather energy LOCALLY in the remote room — the miner's drop pile, or the
  // container if one already holds energy — so building never round-trips home.
  static gather(creep, target) {
    if (creep.room.name !== target.room) {
      creep.travelTo(new RoomPosition(target.x, target.y, target.room), { range: 1 });
      return;
    }
    const pile = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY,
    });
    if (pile) {
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) creep.travelTo(pile);
      return;
    }
    const store = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0,
    });
    if (store) {
      if (creep.withdraw(store, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(store);
      return;
    }
    // Nothing to gather yet — wait by the source for the miner's next drop.
    creep.travelTo(new RoomPosition(target.x, target.y, target.room), { range: 2 });
  }

  // Pull back home out of a hot room until it cools (resumes via the overlord).
  static retreatHome(creep, colony) {
    const anchor = colony.spawns[0] || colony.controller;
    if (anchor) creep.travelTo(anchor, { range: 3 });
  }
}
