import { Role } from "./Role.js";

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
  static run(creep, _colony) {
    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) return; // source out of vision (shouldn't happen in owned room)

    const miningPosition = this.resolveMiningPosition(creep);

    // Phase 1: walk to the mining position if we're not already standing on it.
    if (miningPosition && !creep.pos.isEqualTo(miningPosition)) {
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
