import { Overlord } from "./Overlord.js";
import { Upgrader } from "../roles/Upgrader.js";
import { Hauler } from "../roles/Hauler.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { stageAtLeast } from "../lib/Stages.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";

// ============================================================================
//  UpgradeOverlord — keeps the room controller leveling.
//
//  It also owns the CONTROLLER CONTAINER: a container two tiles short of the
//  controller (on the source->controller approach) that haulers keep filled, so
//  upgraders park beside it and pull energy from range instead of walking all
//  the way back to a source container each cycle (the round-trip walk is pure
//  idle time). The hauler drops off at the edge of the upgrader cluster, not its
//  centre. This mirrors how a MiningOverlord owns its source container — shared
//  ContainerPlanner geometry, inverted: there the miner fills the container,
//  here the hauler does (and the source case hugs its anchor, this one offsets).
//
//  Planning is gated on the 2b:Hauling stage: a source container is finished, so
//  haulers exist to keep this one stocked. Before that, upgraders self-serve.
// ============================================================================
export class UpgradeOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 4 });
  }

  get role() {
    return "upgrader";
  }

  desiredCount() {
    // 1 baseline; 2 once we have some extension capacity.
    return this.room.energyCapacityAvailable >= 550 ? 2 : 1;
  }

  bodyFor(energy) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 4, energy });
  }

  runCreep(creep) {
    Upgrader.run(creep, this.colony);
  }

  // --------------------------------------------------------------------------
  //  Controller-container position: the tile a hauler fills and an upgrader
  //  parks beside. Computed once via the shared ContainerPlanner and cached in
  //  colony memory, mirroring MiningOverlord.miningPosition.
  // --------------------------------------------------------------------------
  get controllerContainerPosition() {
    const cache = this.controllerContainerPositionCache;
    if (cache) {
      return new RoomPosition(cache.x, cache.y, cache.roomName);
    }
    const { position, reachedByPath } = this.computeControllerContainerPosition();
    // Only cache a tile we genuinely reached by path — a transient pathing
    // failure shouldn't become the permanent answer.
    if (position && reachedByPath) {
      this.controllerContainerPositionCache = {
        x: position.x,
        y: position.y,
        roomName: position.roomName,
      };
    }
    return position;
  }

  get controllerContainerPositionCache() {
    return Memory.colonyData?.[this.colony.name]?.controllerContainerPos;
  }

  set controllerContainerPositionCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].controllerContainerPos = value;
  }

  // Two tiles short of the controller on the hauler's approach (NOT hugging it):
  // the hauler drops off before entering the upgrader cluster, and upgraders
  // still pull from range — see ContainerPlanner.controllerContainerTile.
  computeControllerContainerPosition() {
    const controller = this.colony.controller;
    if (!controller) return { position: null, reachedByPath: false };
    return ContainerPlanner.controllerContainerTile(
      this.room,
      controller.pos,
      this.haulerAnchor().pos
    );
  }

  // Where the hauler comes from: the nearest source container (the real trip
  // origin), else the first spawn, else the controller itself. We minimise the
  // controller container's distance to this anchor.
  haulerAnchor() {
    const sourceContainers = this.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        Hauler.isSourceContainer(s, this.colony),
    });
    if (sourceContainers.length > 0) {
      return (
        this.colony.controller.pos.findClosestByPath(sourceContainers) ||
        sourceContainers[0]
      );
    }
    return this.colony.spawns[0] || this.colony.controller;
  }

  // Keep the controller-container site alive once hauling is active.
  ensureControllerContainerSite() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return;
    const position = this.controllerContainerPosition;
    if (!position) return;
    ContainerPlanner.ensureSite(this.room, position, "controller");
  }

  // Called by Colony each tick: place/keep the controller container before
  // driving the upgraders that feed off it.
  run() {
    this.ensureControllerContainerSite();
    super.run();
  }
}
