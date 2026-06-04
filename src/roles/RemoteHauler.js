import { Hauler } from "./Hauler.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteHauler — carries remote energy home (#18 C2, pooled across sources #102).
//
//  Reuses the Hauler's full/empty state machine and its HOME delivery logic
//  (spawn/extensions -> tower -> controller container -> storage). It overrides
//  only the two ends of the trip that differ for a remote:
//    • collect — pick a target remote source (the fullest active pile, #102),
//      cross to its room and grab the RemoteMiner's dropped pile (drop-mining, no
//      container yet → energy is on the ground).
//    • deliver — when full, first travel back to the home room, THEN run the
//      normal home delivery.
//  One shared fleet, NOT welded to a source: each hauler picks the fullest active
//  remote pile when it goes empty and latches it for the load trip (mirroring how
//  home haulers pick the fullest container, #86 anti-oscillation). The base run()
//  clears the latch on the full-load edge, so each trip re-picks → the fleet pools
//  by need across all mined sources. Fleet size = freight model summed over the
//  whole set (#84) in RemoteLogisticsOverlord.
// ============================================================================
export class RemoteHauler extends Hauler {
  // Below home haulers (2): a remote hauler should never shove the core economy,
  // but it still moves energy, so above idle roles.
  static movementPriority = 3;

  static bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget); // same balanced CARRY/MOVE body
  }

  // ---- collect: cross to a remote source and grab the miner's ground pile -----
  static collect(creep, colony) {
    // Hold the source we committed to for this load trip (latched in haulTarget; the
    // base Hauler.run clears it on the full-load edge so the next trip re-picks). Drop
    // it the moment its room turns hot — read from the shared intel (#105), not a
    // local hostile scan (which fled a harmless scout and oscillated at the border).
    let target = creep.memory.haulTarget;
    if (target && Threat.isHot(target.room)) target = creep.memory.haulTarget = null;
    if (!target) {
      // No commitment. Carrying a partial load? Take it home rather than chase a new
      // target mid-route (that re-pick IS the oscillation, #86). Only an empty hauler
      // picks fresh: the fullest active remote pile.
      if (creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.working = true;
        return this.deliver(creep, colony);
      }
      target = this.pickHaulTarget(colony);
      creep.memory.haulTarget = target;
    }
    if (!target) {
      this.note(creep, "rhaul:no-target"); // no active remote — idle home
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
      return;
    }
    const { room: targetRoom, x, y } = target;

    if (creep.room.name !== targetRoom) {
      this.note(creep, "rhaul:to-room");
      creep.travelTo(new RoomPosition(x, y, targetRoom), { range: 3 });
      return;
    }

    // Prefer the source container once it's built (#114): container-mining banks the
    // energy there with zero decay, so it's the real store to drain — fall back to a
    // ground pile only before the container exists.
    const cinfo = Memory.colonyData?.[colony.name]?.remoteContainers?.[`${targetRoom}:${x}:${y}`];
    if (cinfo && cinfo.hits != null) {
      const container = new RoomPosition(cinfo.x, cinfo.y, targetRoom)
        .lookFor(LOOK_STRUCTURES)
        .find((s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0);
      if (container) {
        this.note(creep, "rhaul:withdraw");
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(container);
        return;
      }
    }

    const pile = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY,
    });
    if (pile) {
      this.note(creep, "rhaul:pickup");
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) creep.travelTo(pile);
      return;
    }
    // No pile right now. If we already carry energy, take it home rather than idle
    // (don't wait while the ground pile we'd collect later decays); only an empty
    // hauler waits by the source for the next drop.
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      return this.deliver(creep, colony); // deliver() stamps its own note this tick
    }
    this.note(creep, "rhaul:to-source");
    creep.travelTo(new RoomPosition(x, y, targetRoom), { range: 2 });
  }

  // Pick the remote source to service: the fullest active store (#102). "Fullest" is
  // the energy waiting at a source we can see — the miner's ground pile PLUS the
  // source container's contents (#114), since once a container is built the energy
  // banks there instead of on the ground. A miner gives us vision of its room; with
  // no vision the term is 0 and we fall back to the value-ranked order
  // (remoteSources() is sorted best-first). Hot rooms are excluded.
  static pickHaulTarget(colony) {
    const active = colony.remoteSources().filter((s) => !Threat.isHot(s.room));
    if (!active.length) return null;
    const containers = Memory.colonyData?.[colony.name]?.remoteContainers || {};
    let best = null;
    let bestScore = -1;
    for (const s of active) {
      const room = Game.rooms[s.room];
      let pending = 0;
      if (room) {
        pending += new RoomPosition(s.x, s.y, s.room)
          .findInRange(FIND_DROPPED_RESOURCES, 2, { filter: (r) => r.resourceType === RESOURCE_ENERGY })
          .reduce((sum, r) => sum + r.amount, 0);
        const cinfo = containers[`${s.room}:${s.x}:${s.y}`];
        if (cinfo && cinfo.hits != null) {
          const container = new RoomPosition(cinfo.x, cinfo.y, s.room)
            .lookFor(LOOK_STRUCTURES)
            .find((st) => st.structureType === STRUCTURE_CONTAINER);
          if (container) pending += container.store[RESOURCE_ENERGY];
        }
      }
      // Real energy dominates; value (the sort order) tie-breaks and is the no-vision
      // default so haulers still head to the best source before it's seen.
      const score = pending * 1000 + s.value;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best ? { room: best.room, x: best.x, y: best.y } : null;
  }

  // ---- deliver: get back to the home room, then the normal home delivery -----
  static deliver(creep, colony) {
    if (creep.room.name !== colony.name) {
      this.note(creep, "rhaul:to-home");
      creep.travelTo(new RoomPosition(25, 25, colony.name), { range: 20 });
      return;
    }
    Hauler.deliver(creep, colony);
  }
}
