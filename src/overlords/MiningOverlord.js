import { Overlord } from "./Overlord.js";
import { Miner } from "../roles/Miner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";
import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  MiningOverlord — owns the static mining of ONE source (Overmind-style:
//  one overlord instance per source). The Colony creates one of these for each
//  source in the room, so remote/outpost mining later is just "more instances".
//
//  Responsibilities:
//   1. Decide the single tile a miner should stand on (the "mining position"),
//      which is also where the source's container belongs.
//   2. Keep a container construction site / container alive on that tile.
//   3. Spawn and drive exactly one static Miner for this source.
//
//  Each instance is identified by `miner:<full-sourceId>` so its miner is never
//  confused with another source's miner, even though they share the role
//  "miner".
// ============================================================================
export class MiningOverlord extends Overlord {
  /**
   * @param {Colony} colony
   * @param {Source} source - the specific source this overlord mines
   */
  constructor(colony, source) {
    // Mining is top priority: no energy income means no colony at all.
    // Use the FULL source id as the instance identifier. It's only a memory
    // string, so length doesn't matter, and a truncated suffix could collide
    // between two sources that share their last few chars.
    super(colony, { priority: 1, instanceId: source.id });
    this.source = source;
  }

  get role() {
    return "miner";
  }

  // One static miner per source is enough to fully drain it (5×WORK = 10/tick),
  // but a CARRY-less miner only earns its keep once a container exists to catch
  // its drops and a hauler/worker can move that energy. So gate it on Stage 2:
  // during Bootstrap (Stage 1) the colony lives on self-sufficient generic
  // WorkOverlord workers (WORK+CARRY+MOVE) — mirrors how Logistics/Upgrade wait
  // on "2b:Hauling". Stage 2 enters at RCL≥2 or when a container exists, exactly
  // the moment static mining starts paying off.
  desiredCount() {
    if (!stageAtLeast(this.colony, "2:StaticMining")) return 0;
    return 1;
  }

  // Static miner body: as many WORK parts as we can afford (capped at 5, which
  // exactly matches a source's 3000-energy-per-300-tick regen), plus TWO MOVE.
  // No CARRY — energy drops into the container.
  //
  // Why two MOVE for a creep that ultimately stands still: with 5 WORK the body
  // generates a lot of fatigue while travelling. One MOVE crawls on plains and
  // CANNOT cross swamp at all (it never clears 10 fatigue/step). Two MOVE lets
  // the miner reliably reach its position over mixed terrain on the one-way
  // trip; once parked, the extra MOVE costs nothing. Cheap insurance against
  // the "miner stuck en route" failure mode.
  bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE, MOVE], {
      extra: [WORK],
      max: 4, // template already has 1 WORK, so up to 5 WORK total
      energy: energyBudget,
    });
  }

  // --------------------------------------------------------------------------
  //  Mining position: the tile a miner parks on and the container sits under.
  //  Heuristic: of all walkable tiles adjacent to the source, pick the one
  //  closest (by path) to the colony's first spawn — that minimises hauler
  //  travel. Computed once and cached in the overlord's colony memory so we
  //  don't repeat the pathing every tick.
  // --------------------------------------------------------------------------
  get miningPosition() {
    const cache = this.miningPositionCache;
    if (cache) {
      return new RoomPosition(cache.x, cache.y, cache.roomName);
    }
    const { position, reachedByPath } = this.computeMiningPosition();
    // Only cache a tile we genuinely reached by path. Caching a transient
    // pathing-failure fallback would make a temporary glitch permanent.
    if (position && reachedByPath) {
      this.miningPositionCache = {
        x: position.x,
        y: position.y,
        roomName: position.roomName,
      };
    }
    return position;
  }

  get miningPositionCache() {
    return (Memory.colonyData?.[this.colony.name]?.miningPos || {})[this.source.id];
  }

  set miningPositionCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].miningPos ||= {};
    Memory.colonyData[this.colony.name].miningPos[this.source.id] = value;
  }

  // Walkable source-adjacent tile nearest (by path) to a spawn — minimises the
  // hauler trip. Delegates the geometry to the shared ContainerPlanner so the
  // source and controller containers plan their tiles the same way.
  computeMiningPosition() {
    const anchor = this.colony.spawns[0] || this.colony.controller;
    return ContainerPlanner.bestContainerTile(this.room, this.source.pos, anchor.pos);
  }

  // --------------------------------------------------------------------------
  //  Container lifecycle: make sure a container (or its construction site)
  //  exists on the mining position. Workers build the site; the miner drops
  //  energy into the finished container.
  // --------------------------------------------------------------------------
  ensureContainerSite() {
    const position = this.miningPosition;
    if (!position) return;
    ContainerPlanner.ensureSite(this.room, position, "source");
  }

  // --------------------------------------------------------------------------
  //  Spawn request: stamp the source + mining position onto the new miner so it
  //  knows where to go without recomputing anything.
  // --------------------------------------------------------------------------
  generateSpawnRequest() {
    const request = super.generateSpawnRequest();
    if (!request) return null;

    const position = this.miningPosition;
    request.memory.sourceId = this.source.id;
    request.memory.miningPos = position
      ? { x: position.x, y: position.y, roomName: position.roomName }
      : null;
    return request;
  }

  runCreep(creep) {
    Miner.run(creep, this.colony);
  }

  // Called by Colony each tick. Keeps the container site alive even before any
  // miner exists, re-stamps the mining position onto any creep that lacks one
  // (e.g. creeps adopted via legacy migration), then drives the creeps.
  run() {
    this.ensureContainerSite();
    this.stampMiningPositionOnAssignedCreeps();
    super.run();
  }

  // Make sure every creep we own knows its mining position. New miners get it at
  // spawn time, but adopted (migrated) creeps may not — fill it in here so they
  // can park properly instead of relying on the source-direct fallback forever.
  stampMiningPositionOnAssignedCreeps() {
    const position = this.miningPosition;
    if (!position) return;
    for (const creep of this.assignedCreeps) {
      if (!creep.memory.miningPos) {
        creep.memory.miningPos = {
          x: position.x,
          y: position.y,
          roomName: position.roomName,
        };
      }
    }
  }
}
