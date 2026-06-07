import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// ============================================================================
//  Miner — a STATIC mining creep (Stage 2 economy).
//
//  Unlike the early-game Harvester (which mines AND carries), a Miner does one
//  thing forever: walk to its assigned mining position, stand on it, and harvest
//  the source non-stop. It has no CARRY parts, so the energy it digs spills onto
//  the ground — and ideally onto a container sitting under its feet, which
//  haulers then drain. This is the classic "drop mining into a container" setup:
//  zero energy wasted on the miner walking back and forth.
//
//  The miner is told WHERE to stand and WHICH source to dig by its owning
//  MiningOverlord, via memory:
//    creep.memory.sourceId     -> the source to harvest
//    creep.memory.miningPos    -> {x, y, roomName} tile to stand on (the
//                                 container tile)
//  Both are stamped once by the overlord and never change for this creep's life.
// ============================================================================
export class Miner extends Role {
  // Top movement priority: static income is the economy's root, and a miner's
  // tile IS its job — nothing should ever push it off its post.
  static movementPriority = 1;

  // Static miner body: as many WORK as we can afford (capped at 5 = a source's full
  // 10 energy/tick regen), plus TWO MOVE and no CARRY (energy drops into the
  // container). Two MOVE — not one — because a 5-WORK body builds heavy fatigue en
  // route: one MOVE crawls on plains and can't cross swamp at all; two MOVE gets the
  // miner to its post over mixed terrain, and once parked the extra MOVE is free.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE, MOVE], { extra: [WORK], max: 4, energy: energyBudget });
  }

  // Ticks to cross ONE plain tile en route (the body's locomotion — the miner knows its own
  // speed). Screeps fatigue rule: every body part generates fatigue per step EXCEPT MOVE parts and
  // EMPTY CARRY parts (this is why an empty hauler returns at full speed). A miner travels to its
  // post EMPTY, so only its WORK parts generate fatigue — CARRY (LinkedMiner) is empty and excluded.
  // Plain = 2 fatigue/heavy-part/step; each MOVE clears 2/tick ⇒ ticksPerTile = ceil(heavy / move),
  // min 1. Plain is the conservative assumption (roads only make it faster, so this never under-
  // times a route); used to schedule JIT relief (#168). 5 WORK + 2 MOVE → 3 ticks/tile.
  static ticksPerTile(body) {
    const move = body.filter((p) => p === MOVE).length;
    if (!move) return body.length; // degenerate — a miner always carries MOVE
    const heavy = body.filter((p) => p !== MOVE && p !== CARRY).length;
    return Math.max(1, Math.ceil(heavy / move));
  }

  // Ticks between ORDERING a relief and it standing on the post: spawn time + travel time + a small
  // margin so the relief lands slightly BEFORE the incumbent dies, never after (#168). Pure in
  // (body, dist) — the domain-owned JIT primitive shared by the home MiningOverlord and the remote
  // RemoteMiningOverlord (#210); each supplies its own dist (home: spawn→post path; remote: the
  // source's haul distance). spawnTicks = CREEP_SPAWN_TIME × parts; travel = dist × ticksPerTile(body).
  static replacementLead(body, dist, margin = 20) {
    return body.length * CREEP_SPAWN_TIME + dist * this.ticksPerTile(body) + margin;
  }

  // Energy/tick this body extracts at a given spawn-energy budget: WORK×HARVEST_POWER
  // capped at the source regen (SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME = 10/tick).
  // The logistics fleet sizes itself to this PREDICTED production (#84) — reasoning
  // about the steady-state target for the cap, not reading live (lagging) bodies.
  static harvestRateAt(energyBudget) {
    const workParts = this.bodyFor(energyBudget).filter((part) => part === WORK).length;
    return Math.min(SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME, workParts * HARVEST_POWER);
  }

  // The id of the thing this miner harvests. A source miner reads memory.sourceId; MineralMiner (#19)
  // overrides this to memory.mineralId. Everything else in run() is target-agnostic — `harvest()` is
  // the same API call for a Source or a Mineral (a Mineral just additionally needs a built Extractor).
  static harvestTargetId(creep) {
    return creep.memory.sourceId;
  }

  static run(creep, colony) {
    const source = Game.getObjectById(this.harvestTargetId(creep));
    if (!source) return; // target out of vision (shouldn't happen in owned room)

    const miningPosition = this.resolveMiningPosition(creep);

    // Fallback path: if we have no assigned mining position yet (e.g. a creep
    // adopted by migration before the overlord re-stamped it), just mine the
    // source directly — walk into range and harvest. This guarantees a miner is
    // never stuck doing nothing while waiting for a position.
    if (!miningPosition) {
      this.note(creep, "mine:src-fallback");
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.travelTo(source);
      return;
    }

    // Phase 1: walk to the mining position if we're not already standing on it.
    if (!creep.pos.isEqualTo(miningPosition)) {
      this.note(creep, "mine:to-post");
      creep.travelTo(miningPosition);
      return;
    }

    // Phase 2: we're parked — harvest forever. Energy drops onto the container
    // (or the ground) beneath us; haulers pick it up.
    this.note(creep, "mine:harvest");
    creep.harvest(source);
    this.afterHarvest(creep, colony);
  }

  // Hook: what to do with the harvest beyond the auto-drop into the container under
  // our feet. The base static miner is CARRY-less so it only keeps that container
  // repaired when it happens to hold energy; LinkedMiner overrides this to ferry the
  // harvest one tile into an adjacent source link (#17).
  static afterHarvest(creep, _colony) {
    this.maybeRepairContainerUnderfoot(creep);
  }

  // Rebuild a RoomPosition object from the plain {x,y,roomName} stored in memory.
  static resolveMiningPosition(creep) {
    const stored = creep.memory.miningPos;
    if (!stored) return null;
    return new RoomPosition(stored.x, stored.y, stored.roomName);
  }

  // If standing on a damaged container and we happen to carry energy, repair it.
  static maybeRepairContainerUnderfoot(creep) {
    if (creep.store[RESOURCE_ENERGY] === 0) return;
    const containerHere = creep.pos
      .lookFor(LOOK_STRUCTURES)
      .find((structure) => structure.structureType === STRUCTURE_CONTAINER);
    if (containerHere && containerHere.hits < containerHere.hitsMax) {
      creep.repair(containerHere);
    }
  }
}
