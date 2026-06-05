import { Role } from "./Role.js";
import { ContainerPlanner } from "../lib/ContainerPlanner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

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
//  refinement. The target room + source tile are stamped by RemoteMiningOverlord
//  (#102 — one miner per source). The map already excluded SK/enemy rooms; if its
//  room turns unsafe for the economy (Threat.isHotForEconomy, #150 — gross intel #105
//  netted by our guard present) the miner retreats home until it's safe again.
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
    // The miner just executes its assignment: RemoteMiningOverlord (the domain
    // controller, #102) decides WHICH source this creep serves and stamps it here —
    // and re-homes it when rooms go hot. The role only reads its current target.
    // It holds home when its room is unsafe FOR THE ECONOMY — Threat.isHotForEconomy
    // (#150): the shared intel (#105) netted by our own force present, so it keeps mining
    // while a guard holds the room and flees only if the guard can't (net threat positive).
    const target = creep.memory.remoteSource;
    if (!target) {
      // No assignment → the controller has no safe source for it (or it's a legacy
      // creep from before #102). Recycle rather than idle until death.
      return this.recycleAtHome(creep, colony);
    }
    const { room: targetRoom, x, y } = target;

    if (Threat.isHotForEconomy(targetRoom)) {
      this.note(creep, "rmine:hot");
      return this.retreatHome(creep, colony);
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

    // Sensor for the container infra (#114): the miner is permanently parked on the
    // container tile, so it's the continuous eyes on it. Publish the tile + the live
    // container hits (null = none built yet) per source, so RemoteWorkOverlord can
    // size build/repair work and RemoteHauler can withdraw from the container.
    const container = creep.pos.lookFor(LOOK_STRUCTURES).find((s) => s.structureType === STRUCTURE_CONTAINER);
    Memory.colonyData ||= {};
    (Memory.colonyData[colony.name] ||= {}).remoteContainers ||= {};
    Memory.colonyData[colony.name].remoteContainers[`${targetRoom}:${x}:${y}`] = {
      x: mp.x, y: mp.y, roomName: targetRoom,
      hits: container ? container.hits : null,
      hitsMax: container ? container.hitsMax : null,
    };

    this.note(creep, "rmine:harvest");
    creep.harvest(source); // no CARRY → energy drops on this tile (into the container once built)
  }

  // Pull back home out of the hostile room until it's safe again.
  static retreatHome(creep, colony) {
    const anchor = colony.spawns[0] || colony.controller;
    if (anchor) creep.travelTo(anchor, { range: 3 });
  }
}
