import { Behavior } from "../Behavior.js";
import { Hauler } from "../../roles/Hauler.js";

// ============================================================================
//  RemoteHaul (#204) — the first ECONOMY behavior: carry a remote source's energy
//  home. The economy counterpart of the combat conduct nodes — a thin RemoteHauler
//  role runs the BehaviorMachine, and this node holds the haul conduct.
//
//  COMMAND PATTERN (like the combat behaviors): this node never DECIDES which source
//  to service — the RemoteLogisticsOverlord stamps creep.memory.haulTarget = {room,x,y}
//  each tick (balanced across the fleet, fleet-aware), and this node only EXECUTES it.
//  Selection is the controller's; execution is the model's.
//
//  It reuses the shared gather↔deliver skeleton (Hauler.runCycle) and the home
//  delivery ladder (Hauler.deliver) — only the two ends of the trip differ for a
//  remote: cross to the assigned source room and grab the miner's energy; when full,
//  hop back home first, then deliver.
// ============================================================================
export class RemoteHaul extends Behavior {
  // The economy hauler body (balanced CARRY/MOVE) — the model owns its body; the
  // RemoteLogisticsOverlord reads this off the default behavior to size the spawn.
  static bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget);
  }

  // Drive the gather↔deliver cycle, with THIS node's collect/deliver as the phase conduct.
  static run(creep, colony) {
    Hauler.runCycle(creep, colony, this);
  }

  // ---- collect: cross to the assigned remote source and grab its energy --------
  static collect(creep, colony) {
    const target = creep.memory.haulTarget;
    if (!target) {
      // No assignment this tick (no active remote, or the overlord freed a now-hot room).
      // Carrying a partial load? Deliver it rather than idle — never chase a fresh pickup
      // mid-route (#86). Only a truly empty hauler waits at home for next tick's assignment.
      if (creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.working = true;
        return this.deliver(creep, colony);
      }
      this.note(creep, "rhaul:no-target");
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
      return;
    }
    const { room: targetRoom, x, y } = target;

    if (creep.room.name !== targetRoom) {
      this.note(creep, "rhaul:to-room");
      creep.travelTo(new RoomPosition(x, y, targetRoom), { range: 3 });
      return;
    }

    // Source container built (#114): drain it. Take BOTH the decaying overflow on its own tile AND the
    // banked store the SAME tick — pickup and withdraw are separate intents that both apply, so a capped
    // container is emptied while the energy rotting on top of it is saved (#204). The goal is to haul it
    // ALL home: don't return after the pickup and leave the container's energy sitting.
    const cinfo = Memory.colonyData?.[colony.name]?.remoteContainers?.[`${targetRoom}:${x}:${y}`];
    if (cinfo && cinfo.hits != null) {
      const cpos = new RoomPosition(cinfo.x, cinfo.y, targetRoom);
      const container = cpos.lookFor(LOOK_STRUCTURES).find((s) => s.structureType === STRUCTURE_CONTAINER);
      if (container) {
        const overflow = cpos.lookFor(LOOK_RESOURCES).find((r) => r.resourceType === RESOURCE_ENERGY);
        const banked = container.store[RESOURCE_ENERGY] > 0;
        if (overflow || banked) {
          // range 1: pickup/withdraw both work adjacent, and we must NOT path onto the container tile —
          // the RemoteMiner parks there and a remote hauler outranks it in traffic (would shove it off
          // its post). Surface the overflow save in the trace when there is one.
          if (!creep.pos.isNearTo(cpos)) {
            this.note(creep, overflow ? "rhaul:pickup" : "rhaul:withdraw");
            creep.travelTo(cpos, { range: 1 });
            return;
          }
          // The decaying overflow on the tile takes PRIORITY (it rots ~1/tick; the container's store does
          // not). Pick up the WHOLE pile first, then withdraw only the REMAINING free capacity from the
          // container. Capping the withdraw amount reserves room for the ground regardless of the order
          // the engine applies the two intents — so the ground is never lost to a "container fills first"
          // race (the bug a naive simultaneous pickup+withdraw caused).
          const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
          const ground = overflow ? Math.min(overflow.amount, free) : 0;
          this.note(creep, overflow ? "rhaul:pickup" : "rhaul:withdraw");
          if (overflow) creep.pickup(overflow);
          const room = free - ground;
          if (banked && room > 0) {
            creep.withdraw(container, RESOURCE_ENERGY, Math.min(container.store[RESOURCE_ENERGY], room));
          }
          return;
        }
      }
    }

    // No container yet (pre-#114 era) — grab the miner's loose ground pile.
    const pile = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      ignoreCreeps: true, // select as if no creeps; travelTo routes around them (#63)
      filter: (r) => r.resourceType === RESOURCE_ENERGY,
    });
    if (pile) {
      this.note(creep, "rhaul:pickup");
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) creep.travelTo(pile);
      return;
    }
    // Nothing to grab right now. Carrying a partial load → take it home rather than idle while a
    // pile accrues (#86); an empty hauler waits by the source for the miner's next drop.
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      return this.deliver(creep, colony);
    }
    this.note(creep, "rhaul:to-source");
    creep.travelTo(new RoomPosition(x, y, targetRoom), { range: 2 });
  }

  // ---- deliver: get back to the home room, then the normal home delivery -------
  static deliver(creep, colony) {
    if (creep.room.name !== colony.name) {
      this.note(creep, "rhaul:to-home");
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
      return;
    }
    Hauler.deliver(creep, colony);
  }
}
