import { Overlord } from "./Overlord.js";
import { Upgrader } from "../roles/Upgrader.js";
import { Hauler } from "../roles/Hauler.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { stageAtLeast } from "../lib/Stages.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";

// Upgraders to run when energy is going to waste (#81) — drains the surplus into
// the controller instead of letting source regen burn.
const UPGRADERS_RICH = 3;

// Storage-proportional upgrader scaling (#137), ADDED on top of the #81 baseline. The
// controller is the only meaningful sink for surplus before a 2nd spawn (RCL7) lets us
// expand, so banked energy should drain into RCL rather than sit. Self-regulating via
// storage LEVEL: storage is the lowest hauler-delivery priority, so its depth is the
// true post-consumption surplus. All tunable from live behaviour.
const UPGRADE_STORAGE_RESERVE = 20000; // bank this cushion before adding any extra upgrader
const ENERGY_PER_UPGRADER = 30000; // surplus above the reserve that justifies one extra upgrader
const UPGRADE_EXTRA_MAX = 4; // ceiling on the bonus so the single spawn isn't swamped

// ============================================================================
//  UpgradeOverlord — keeps the room controller leveling.
//
//  It also owns the CONTROLLER CONTAINER: a container two tiles short of the
//  controller (on the source->controller approach) that haulers keep filled, so
//  upgraders park on/beside it — withdrawing at range 1 and upgrading at range 3
//  — instead of walking all the way back to a source container each cycle (the
//  round-trip walk is pure idle time). The hauler drops off at the edge of the
//  upgrader cluster, not its centre. This mirrors how a MiningOverlord owns its
//  source container — shared ContainerPlanner geometry, inverted: there the miner
//  fills the container, here the hauler does (and the source case hugs its
//  anchor, this one offsets).
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
    return this.baseCount() + this.storageDelta();
  }

  // The #81 baseline, unchanged: burn idle energy into the controller when sources
  // back up (energyRich), else 1, or 2 once extensions can feed two. The storage delta
  // rides ON TOP of this, so pre-storage early game behaves exactly as before.
  baseCount() {
    if (this.colony.health.energyRich) return UPGRADERS_RICH;
    return this.room.energyCapacityAvailable >= 550 ? 2 : 1;
  }

  // Extra upgraders proportional to the banked storage surplus (#137). Self-regulating:
  // storage is the LOWEST hauler-delivery priority (after spawn/extensions/tower/the
  // controller container), so a rising storage means the controller container is already
  // kept fed — the extra upgraders are guaranteed energy. As they consume the surplus,
  // storage stops climbing and the count settles at equilibrium (consumption ≈ source
  // surplus). Reserve-gated (bank a cushion first), capped (so the single spawn isn't
  // swamped), and zeroed during recovery (don't burn the controller while clawing out of
  // a workforce collapse — but NOT gated on `decaying`: upgrading is the FIX for that).
  // Read live, not smoothed: the per-upgrader granularity dwarfs per-tick storage jitter,
  // so the count can't chatter (same live-read sizing idiom as WorkOverlord's backlog).
  storageDelta() {
    if (this.colony.health.recovering) return 0;
    const storage = this.colony.room.storage;
    if (!storage) return 0; // pre-storage (early game) → no delta
    const surplus = storage.store[RESOURCE_ENERGY] - UPGRADE_STORAGE_RESERVE;
    return Math.min(Math.max(Math.floor(surplus / ENERGY_PER_UPGRADER), 0), UPGRADE_EXTRA_MAX);
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
