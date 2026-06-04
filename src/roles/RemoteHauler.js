import { Hauler } from "./Hauler.js";

// ============================================================================
//  RemoteHauler — carries a remote source's energy home (#18, slice C2).
//
//  Reuses the Hauler's full/empty state machine and its HOME delivery logic
//  (spawn/extensions -> tower -> controller container -> storage). It overrides
//  only the two ends of the trip that differ for a remote:
//    • collect — cross to the target room and pick up the RemoteMiner's dropped
//      pile (the miner drop-mines; with no container yet, the energy is on the
//      ground).
//    • deliver — when full, first travel back to the home room, THEN run the
//      normal home delivery.
//  The fleet size comes from the freight model (#84) applied to the longer remote
//  haul, in RemoteLogisticsOverlord. Target room + source tile are stamped at spawn.
// ============================================================================
export class RemoteHauler extends Hauler {
  // Below home haulers (2): a remote hauler should never shove the core economy,
  // but it still moves energy, so above idle roles.
  static movementPriority = 3;

  static bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget); // same balanced CARRY/MOVE body
  }

  // ---- collect: cross to the remote source and grab the miner's ground pile --
  static collect(creep, colony) {
    // Live target (#105): remoteSource() skips hot/contested rooms, so collect
    // automatically re-routes to a safe remote when ours is invaded — and no
    // per-tick hostile scan, which is what fled a harmless scout and oscillated at
    // the border. No safe remote: take a partial load home, else idle home.
    const target = colony.remoteSource();
    if (!target) {
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
