import { ContainerPlanner } from "./ContainerPlanner.js";

// ============================================================================
//  MiningSite — the shared container-mining-site lifecycle (#19), extracted from MiningOverlord once
//  mineral mining became its 2nd tenant (defer-abstraction-until-2nd-instance). It owns the two pieces
//  every "static-mine a target into an adjacent container a hauler drains" overlord needs:
//
//   1. the mining POSITION — the walkable tile adjacent to the harvest target, nearest (by path) to a
//      spawn, where the miner parks and its container sits. Computed ONCE via the shared
//      ContainerPlanner geometry, then cached in `Memory.colonyData[colony].miningPos[target.id]` so
//      the pathing never repeats (cached only on a genuine path success — a transient pathing glitch
//      must not become a permanent bad tile).
//   2. the container SITE — kept alive on that tile each tick (workers build it; the miner drops into it).
//
//  Keyed by `target.id`, so a source's site and the mineral's site coexist in the same `miningPos` map
//  with no collision. MiningOverlord layers source-only state (the JIT-relief `dist`) onto the SAME
//  cache object in place — this class only ever writes the position fields, so that coexists untouched.
//  Geometry stays in ContainerPlanner; this owns only the cache + keep-alive plumbing both tenants share.
// ============================================================================
export class MiningSite {
  // @param target - the Source or Mineral to mine (anything with `.pos` and `.id`)
  // @param label  - log prefix passed through to ContainerPlanner.ensureSite ("source" / "mineral")
  constructor(colony, target, label) {
    this.colony = colony;
    this.room = colony.room;
    this.target = target;
    this.label = label;
  }

  // The cached mining tile, or null until a reachable one is computed + cached.
  get position() {
    const cache = this.cache;
    if (cache) return new RoomPosition(cache.x, cache.y, cache.roomName);
    const anchor = this.colony.spawns[0] || this.colony.controller;
    if (!anchor) return null;
    const { position, reachedByPath } = ContainerPlanner.bestContainerTile(
      this.room,
      this.target.pos,
      anchor.pos
    );
    if (position && reachedByPath) {
      this.cache = { x: position.x, y: position.y, roomName: position.roomName };
    }
    return position;
  }

  // Keep a container (or its construction site) alive on the mining tile. No container without a spawn
  // (#228): a spawnless colony builds its spawn first, and a container is useless without the miner the
  // spawn produces. The home colony (spawn from tick 0) is never spawnless, so it's unaffected.
  ensureContainer() {
    if (this.colony.spawns.length === 0) return;
    const position = this.position;
    if (!position) return;
    ContainerPlanner.ensureSite(this.room, position, this.label);
  }

  get cache() {
    return (Memory.colonyData?.[this.colony.name]?.miningPos || {})[this.target.id];
  }

  set cache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].miningPos ||= {};
    Memory.colonyData[this.colony.name].miningPos[this.target.id] = value;
  }
}
