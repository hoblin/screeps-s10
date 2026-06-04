import { Role } from "./Role.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// ============================================================================
//  RemoteMiner — a static miner in an ADJACENT room (#18, slice C2).
//
//  Like the home Miner it has no CARRY and drop-mines: it parks on a fixed
//  source-adjacent tile and harvests forever, so the energy piles on that tile
//  for the RemoteHauler to pick up. The difference is geography — it first
//  crosses the border to the target room (multi-room travelTo, #92) and, with no
//  remote WorkOverlord to plan for it, picks its own parking tile on arrival.
//
//  v1 drops on the ground (no container) — simplest, and the hauler grabs the
//  pile; a self-built container (less decay over the long haul) is a later
//  refinement. The target room + source tile are stamped by RemoteMiningOverlord.
//  The map already excluded SK/enemy rooms; this role adds the live hostile check.
// ============================================================================
export class RemoteMiner extends Role {
  // Low priority: it lives parked on a foreign source, far from home traffic.
  static movementPriority = 5;

  // WORK to harvest + MOVE to make the trip; no CARRY (drop-mining). Scale WORK
  // with the budget up to a source's full drain (5 WORK = 10/tick).
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE, MOVE], { extra: [WORK], max: 4, energy: energyBudget });
  }

  static run(creep, colony) {
    // The remote source is read LIVE from the colony, not stamped at spawn (#105):
    // remoteSource() skips contested (hot) rooms, so when our target is invaded this
    // resolves to the next SAFE remote and the miner re-routes there automatically;
    // null means no safe remote remains → wait at home (the safe fallback). Threat
    // avoidance lives in target selection — no per-tick hostile scan/flee here, which
    // is what used to flee a harmless scout and oscillate at the border.
    const target = colony.remoteSource();
    if (!target) {
      this.note(creep, "rmine:no-target");
      return this.retreatHome(creep, colony);
    }
    const { room: targetRoom, x, y } = target;

    // Re-routed to a different room? Drop the stale parking tile so we recompute one
    // in the NEW room rather than walking to a tile that no longer applies.
    if (creep.memory.miningPos && creep.memory.miningPos.roomName !== targetRoom) {
      creep.memory.miningPos = null;
    }

    // Cross the border first (the foreign-room branch of travelTo, #92).
    if (creep.room.name !== targetRoom) {
      this.note(creep, "rmine:to-room");
      creep.travelTo(new RoomPosition(x, y, targetRoom), { range: 1 });
      return;
    }

    const source = creep.room.lookForAt(LOOK_SOURCES, x, y)[0];
    if (!source) return; // out of vision / wrong tile — shouldn't happen once here

    // Pick a fixed parking tile adjacent to the source once (cached), so the
    // dropped energy always piles in the same spot. Use ContainerPlanner (the
    // closest reachable adjacent tile to us) and only cache one we genuinely
    // reached by path — caching an unreachable tile would strand the miner pathing
    // to it forever (mirrors MiningOverlord's reachedByPath guard).
    let mp = creep.memory.miningPos;
    if (!mp) {
      const { position, reachedByPath } = ContainerPlanner.bestContainerTile(creep.room, source.pos, creep.pos);
      if (!position) return; // source walled in — nothing to do
      if (!reachedByPath) {
        creep.travelTo(position); // approach; resolve a reachable tile next tick
        return;
      }
      creep.memory.miningPos = { x: position.x, y: position.y, roomName: targetRoom };
      mp = creep.memory.miningPos;
    }
    if (creep.pos.x !== mp.x || creep.pos.y !== mp.y) {
      this.note(creep, "rmine:to-post");
      creep.travelTo(new RoomPosition(mp.x, mp.y, targetRoom));
      return;
    }

    this.note(creep, "rmine:harvest");
    creep.harvest(source); // no CARRY → energy drops on this tile for the hauler
  }

  // Pull back home out of the hostile room until it's safe again.
  static retreatHome(creep, colony) {
    const anchor = colony.spawns[0] || colony.controller;
    if (anchor) creep.travelTo(anchor, { range: 3 });
  }
}
