import { Hatchery } from "./hiveClusters/Hatchery.js";
import { MiningOverlord } from "./overlords/MiningOverlord.js";
import { LogisticsOverlord } from "./overlords/LogisticsOverlord.js";
import { UpgradeOverlord } from "./overlords/UpgradeOverlord.js";
import { WorkOverlord } from "./overlords/WorkOverlord.js";
import { ReserveOverlord } from "./overlords/ReserveOverlord.js";
import { DefenseOverlord } from "./overlords/DefenseOverlord.js";
import { RoomHealthCheck } from "./lib/RoomHealthCheck.js";
import { log } from "./lib/Logger.js";

// ============================================================================
//  Colony — everything owned around a single room controller.
//  (Overmind term. Think of it as a per-room aggregate / service container.)
//
//  A Colony wires together:
//   - HiveClusters: physical sub-systems (Hatchery = spawns+extensions)
//   - Overlords: goal-oriented managers that own a set of creeps + a job
//
//  The Colony itself holds no creep logic; it delegates to overlords.
// ============================================================================
export class Colony {
  constructor(room) {
    this.room = room;
    this.name = room.name;
    this.controller = room.controller;
    this.spawns = room.find(FIND_MY_SPAWNS);
    // Nearest-spawn-first: the first MiningOverlord (and thus the bootstrap
    // miner) must seat on the source closest to the base, not whatever order
    // FIND_SOURCES happens to return — a far first source means long energy
    // hauls and a crawling cold-start RCL (issue #68).
    this.sources = this.orderSourcesNearestFirst(room.find(FIND_SOURCES));

    // Group this colony's living creeps by their role for cheap lookup.
    this.creepsByRole = this.groupCreeps();

    // HiveClusters (physical infrastructure)
    this.hatchery = new Hatchery(this);

    // Overlords (goal managers). Order matters for spawn priority.
    //
    // Mining is per-source: one MiningOverlord instance per source in the room.
    // This mirrors Overmind and means remote/outpost mining later is just
    // "spawn more MiningOverlords" rather than a structural change.
    const miningOverlords = this.sources.map(
      (source) => new MiningOverlord(this, source)
    );

    this.overlords = [
      ...miningOverlords,
      new WorkOverlord(this),
      new LogisticsOverlord(this), // requests 0 haulers until 2b:Hauling stage
      new UpgradeOverlord(this),
      new ReserveOverlord(this), // 0 reservers until health.expansionReady (#18 C1)
      new DefenseOverlord(this), // places + operates towers (no-op until RCL3)
    ];
  }

  groupCreeps() {
    const byRole = {};
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.colony !== this.name) continue;
      const role = creep.memory.role || "unknown";
      (byRole[role] ||= []).push(creep);
    }
    return byRole;
  }

  creepsWithRole(role) {
    return this.creepsByRole[role] || [];
  }

  // Economic-dynamics signals for THIS tick (energy surplus, build backlog,
  // blocker flags) — the continuous dial overlords read in desiredCount()
  // instead of hardcoded creep counts (#81). Computed once and cached on the
  // per-tick instance (the Colony is rebuilt every tick, so the field is
  // naturally fresh); the hysteresis latch lives in Memory. See RoomHealthCheck.
  get health() {
    return (this._health ??= RoomHealthCheck.compute(this));
  }

  // Order sources by ascending REAL path cost from the base to each source, so
  // the bootstrap miner lands on the spawn-closest source. Path cost (not raw
  // Chebyshev range) so a walled detour is ranked by the trip a hauler actually
  // walks. Source/spawn geometry is static, so the order is computed once and
  // cached in Memory (the same store the mining positions use); later ticks just
  // reorder by the cached id list, keeping the per-tick Colony rebuild cheap.
  orderSourcesNearestFirst(sources) {
    if (sources.length < 2) return sources;

    const byId = new Map(sources.map((source) => [source.id, source]));
    const cached = Memory.colonyData?.[this.name]?.sourceOrder;
    if (Array.isArray(cached) && cached.length === sources.length) {
      const ordered = cached.map((id) => byId.get(id));
      // Trust the cache only when it maps 1:1 onto the room's current sources —
      // every id resolves AND there are no duplicates. A corrupt cache (e.g.
      // [id1, id1]) would otherwise drop a source and starve a MiningOverlord.
      if (ordered.every(Boolean) && new Set(cached).size === sources.length) {
        return ordered;
      }
    }

    const anchor = this.spawns[0] || this.controller;
    if (!anchor) return sources; // can't rank without a base anchor yet

    const ranked = sources
      .map((source) => ({ source, cost: this.pathCostTo(anchor.pos, source) }))
      .sort(
        (a, b) =>
          a.cost - b.cost || (a.source.id < b.source.id ? -1 : 1) // stable tiebreak by id
      );

    // Don't cache a transient pathing failure as the permanent order.
    if (ranked.every((entry) => entry.cost < Infinity)) {
      Memory.colonyData ||= {};
      Memory.colonyData[this.name] ||= {};
      Memory.colonyData[this.name].sourceOrder = ranked.map((entry) => entry.source.id);
    }

    return ranked.map((entry) => entry.source);
  }

  // Path-step count from `anchorPos` to a tile adjacent to `source` (the source
  // tile itself is an obstacle — the miner stands at range 1). Infinity when the
  // source can't be reached, so unreachable sources sort last.
  pathCostTo(anchorPos, source) {
    // Anchor already adjacent: nearest possible, and findPathTo(range:1) returns
    // an empty path when already in range — which would otherwise read as
    // unreachable (Infinity) and mis-sort an adjacent source last.
    if (anchorPos.getRangeTo(source.pos) <= 1) return 0;
    const path = anchorPos.findPathTo(source.pos, { ignoreCreeps: true, range: 1 });
    const last = path[path.length - 1];
    const reaches = last && source.pos.getRangeTo(last.x, last.y) <= 1;
    return reaches ? path.length : Infinity;
  }

  // Path-step distance between two fixed tiles (static layout — ignore creeps), with
  // the same reachability guard as pathCostTo: a path that doesn't actually arrive
  // reads as Infinity, not a deceptively short trip. Minimum 1 (adjacent = one step),
  // so a hauled source never contributes zero distance to the freight model (#84).
  pathLength(fromPos, toPos) {
    if (fromPos.getRangeTo(toPos) <= 1) return 1;
    const path = fromPos.findPathTo(toPos, { ignoreCreeps: true, range: 1 });
    const last = path[path.length - 1];
    const reaches = last && toPos.getRangeTo(last.x, last.y) <= 1;
    return reaches ? path.length : Infinity;
  }

  // The tile a source's miner parks on — its container sits there. MiningOverlord
  // caches it (once reached by path) in colonyData.miningPos; null until then.
  sourceContainerPos(source) {
    const cache = Memory.colonyData?.[this.name]?.miningPos?.[source.id];
    return cache ? new RoomPosition(cache.x, cache.y, cache.roomName) : null;
  }

  // The controller container: a non-source container within range 3 of the
  // controller (ContainerPlanner places it ≤3 tiles short). The colony owns this
  // structure query — roles/overlords ask it rather than re-scanning the room.
  // Memoized on the per-tick Colony instance (like `health`): Hauler.deliver hits
  // this twice per hauler per tick, so we scan the room at most once per tick. The
  // result can be null, so the cache sentinel is `undefined`, not a `??=` truthiness.
  controllerContainer() {
    if (this._controllerContainer !== undefined) return this._controllerContainer;
    let container = null;
    if (this.controller) {
      const near = this.controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      container = near.find((c) => !this.isSourceContainerTile(c.pos)) || null;
    }
    this._controllerContainer = container;
    return container;
  }

  // Drop-off the haulers feed for the controller: the live container if built, else
  // its planned tile — so the freight fleet can be sized before it finishes (#84).
  controllerDropoffPos() {
    const built = this.controllerContainer();
    if (built) return built.pos;
    const planned = Memory.colonyData?.[this.name]?.controllerContainerPos;
    return planned ? new RoomPosition(planned.x, planned.y, planned.roomName) : null;
  }

  // A container tile is a source container iff it's adjacent to one of our sources.
  isSourceContainerTile(pos) {
    return this.sources.some((source) => source.pos.getRangeTo(pos) <= 1);
  }

  run(lowBucket) {
    // 1. Each overlord decides what it wants (spawn requests) and runs its creeps.
    const spawnRequests = [];
    for (const overlord of this.overlords) {
      try {
        const req = overlord.generateSpawnRequest();
        if (req) spawnRequests.push(...[].concat(req));
        overlord.run();
      } catch (err) {
        log.error(`[${this.name}] Overlord ${overlord.constructor.name}: ${err.stack || err}`);
      }
    }

    // 2. Hatchery fulfils the highest-priority spawn request.
    if (!lowBucket) {
      this.hatchery.run(spawnRequests);
    }
  }
}
