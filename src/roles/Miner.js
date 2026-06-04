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

  // Energy/tick this body extracts at a given spawn-energy budget: WORK×HARVEST_POWER
  // capped at the source regen (SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME = 10/tick).
  // The logistics fleet sizes itself to this PREDICTED production (#84) — reasoning
  // about the steady-state target for the cap, not reading live (lagging) bodies.
  static harvestRateAt(energyBudget) {
    const workParts = this.bodyFor(energyBudget).filter((part) => part === WORK).length;
    return Math.min(SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME, workParts * HARVEST_POWER);
  }

  static run(creep, _colony) {
    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) return; // source out of vision (shouldn't happen in owned room)

    const miningPosition = this.resolveMiningPosition(creep);

    // Fallback path: if we have no assigned mining position yet (e.g. a creep
    // adopted by migration before the overlord re-stamped it), just mine the
    // source directly — walk into range and harvest. This guarantees a miner is
    // never stuck doing nothing while waiting for a position.
    if (!miningPosition) {
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.travelTo(source);
      return;
    }

    // Phase 1: walk to the mining position if we're not already standing on it.
    if (!creep.pos.isEqualTo(miningPosition)) {
      creep.travelTo(miningPosition);
      return;
    }

    // Phase 2: we're parked — harvest forever. Energy drops onto the container
    // (or the ground) beneath us; haulers pick it up.
    creep.harvest(source);

    // Opportunistic top-up: if a container is right under us and the miner
    // somehow holds energy (it won't without CARRY, but future bodies might),
    // repair the container so it doesn't decay. Cheap insurance.
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
