import { Overlord } from "./Overlord.js";
import { Upgrader } from "../roles/Upgrader.js";
import { behaviorClass } from "../behaviors/index.js";
import { stageAtLeast } from "../lib/Stages.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";

// Surplus-proportional upgrader scaling (#137, generalised to pre-storage in #251). The controller
// is the only meaningful energy SINK before a 2nd spawn (RCL7) lets us expand, so banked surplus
// should drain into RCL rather than sit (a full container = waste). Self-regulating via the buffer
// LEVEL: the count rides on how deep the surplus has pooled, and as upgraders consume it the pool
// stops climbing and the count settles (consumption ≈ source surplus). The loop closes through the
// hauler priority chain — storage / source containers are the LOWEST delivery priority, so a rising
// buffer means the controller container is already fed and the extra upgraders are guaranteed energy.
//
// TWO buffer SCALES, because the buffer is a different structure pre- vs post-storage:
//  • STORAGE (RCL4+): a deep central buffer — bank a big cushion, one upgrader per large slice.
//  • SOURCE CONTAINERS (pre-storage): the only buffer is the 2000-cap source containers, so the scale
//    is ~10× smaller — react to a shallow backup, one upgrader per small slice. Pre-storage the count
//    is ALSO bounded physically by the parking tiles around the controller container (~5-6), which the
//    shared EXTRA_MAX cap aligns with. All tunable from live behaviour.
const UPGRADE_STORAGE_RESERVE = 20000; // storage cushion banked before any extra upgrader
const ENERGY_PER_UPGRADER = 30000; // storage surplus above the reserve per extra upgrader
const CONTAINER_BUFFER_RESERVE = 500; // source-container backup tolerated before any extra upgrader
const ENERGY_PER_UPGRADER_CONTAINER = 1500; // container backup above the reserve per extra upgrader
const UPGRADE_EXTRA_MAX = 4; // ceiling on the bonus (single spawn / parking tiles)

// A maxed (RCL8) controller accepts at most 15 energy/tick, and each WORK upgrades 1/tick
// (UPGRADE_CONTROLLER_POWER), so 15 WORK saturates it. Beyond that, extra WORK is dead weight, so it
// caps both the body (one upgrader never needs more than 15 WORK) and, at RCL8, the total fielded
// WORK across the fleet (#248).
// Below RCL8 there is NO per-tick controller cap, so the surplus-driven count stands and bigger
// upgraders just drain the storage hoard into RCL faster (the #137 intent).
const RCL8_UPGRADE_CAP = 15;

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
    // Recovery is WORKERS-ONLY: drop upgraders entirely so every joule funds the climb-out. The base count
    // (1–2) was ungated before — only bufferDelta() zeroed — so 1–2 upgraders kept burning energy a collapsed
    // colony can't spare; the controller-downgrade timer (~40k ticks) far outlasts a recovery (#282).
    if (this.colony.health.recovering) return 0;
    return this.workCappedCount(this.baseCount() + this.bufferDelta());
  }

  // At RCL8 the controller accepts ≤15 energy/tick, so fielding more than 15 WORK total wastes spawn
  // energy on parts it ignores — cap the count so count × WORK-per-upgrader ≤ 15. Below RCL8 there's no
  // such cap (the surplus-driven count stands; bigger upgraders drain the hoard faster). (#248)
  workCappedCount(count) {
    if (this.colony.controller.level < 8) return count;
    const perBody = this.bodyFor(this.colony.spawnEnergyBudget()).filter((p) => p === WORK).length;
    if (!perBody) return count;
    return Math.max(1, Math.min(count, Math.floor(RCL8_UPGRADE_CAP / perBody)));
  }

  // The always-on FLOOR: enough to keep the controller from downgrading and give it constant
  // pressure — 2 once extensions can feed two upgraders, else 1. The buffer delta rides ON TOP for
  // the surplus case. The old `energyRich`→3 branch is RETIRED (#251): `energyRich` keys on source
  // saturation, which static mining keeps low by design, so it almost never fires in a mature colony
  // and can't see a downstream (container) backup — the buffer delta now covers surplus at every RCL.
  baseCount() {
    return this.room.energyCapacityAvailable >= 550 ? 2 : 1;
  }

  // Extra upgraders proportional to the banked-energy SURPLUS (#137/#251). Self-regulating via the
  // buffer LEVEL: the buffer is storage (RCL4+) or, before storage exists, the sum of the source
  // containers — both the LOWEST hauler-delivery priority, so a rising level means the controller
  // container is already kept fed and the extra upgraders are guaranteed energy. As they consume the
  // surplus the level stops climbing and the count settles at equilibrium (consumption ≈ source
  // surplus). Reserve-gated (bank a cushion first) and capped. Recovery is handled UPSTREAM in
  // desiredCount (the WHOLE count → 0, workers-only #282), so there's no recovery guard here; NOT gated on
  // `decaying` either, since upgrading is the FIX for a decaying controller.
  // Read live, not smoothed: the per-upgrader granularity dwarfs per-tick buffer jitter, so the count
  // can't chatter (same live-read sizing idiom as WorkOverlord's backlog).
  bufferDelta() {
    const storage = this.colony.room.storage;
    if (storage) {
      return this.surplusUpgraders(storage.store[RESOURCE_ENERGY], UPGRADE_STORAGE_RESERVE, ENERGY_PER_UPGRADER);
    }
    // Pre-storage: the source containers ARE the surplus buffer (the colony owns the structure query).
    const banked = this.colony.sourceContainers().reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
    return this.surplusUpgraders(banked, CONTAINER_BUFFER_RESERVE, ENERGY_PER_UPGRADER_CONTAINER);
  }

  // One extra upgrader per `step` of energy banked above `reserve`, clamped to [0, EXTRA_MAX].
  surplusUpgraders(buffered, reserve, step) {
    return Math.min(Math.max(Math.floor((buffered - reserve) / step), 0), UPGRADE_EXTRA_MAX);
  }

  // The body is the model's: read it off the unit's default behaviour (the `upgradeController` node
  // owns the WORK/CARRY/MOVE recipe, scaled to 15×WORK / #248), sized to the colony's spawn budget.
  bodyFor(energyBudget) {
    return behaviorClass(Upgrader.behaviors.default).bodyFor(energyBudget);
  }

  // Stamp the behaviour set at birth so the BehaviorMachine drives the thin Upgrader role (#251).
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (req) req.memory.behaviors = Upgrader.behaviors;
    return req;
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
    const sourceContainers = this.colony.sourceContainers();
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
