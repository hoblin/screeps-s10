import { Hatchery } from "./hiveClusters/Hatchery.js";
import { CommandCenter } from "./hiveClusters/CommandCenter.js";
import { MiningOverlord } from "./overlords/MiningOverlord.js";
import { LogisticsOverlord } from "./overlords/LogisticsOverlord.js";
import { UpgradeOverlord } from "./overlords/UpgradeOverlord.js";
import { WorkOverlord } from "./overlords/WorkOverlord.js";
import { ReserveOverlord } from "./overlords/ReserveOverlord.js";
import { RemoteMiningOverlord } from "./overlords/RemoteMiningOverlord.js";
import { RemoteWorkOverlord } from "./overlords/RemoteWorkOverlord.js";
import { RemoteLogisticsOverlord } from "./overlords/RemoteLogisticsOverlord.js";
import { GuardOverlord } from "./overlords/GuardOverlord.js";
import { DefenseOverlord } from "./overlords/DefenseOverlord.js";
import { ScoutOverlord } from "./overlords/ScoutOverlord.js";
import { RoomHealthCheck } from "./lib/RoomHealthCheck.js";
import { Miner } from "./roles/Miner.js";
import { bodyCost } from "./lib/BodyGenerator.js";
import expansionMap from "./data/expansionMap.json";
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
    // Central structures: Storage (moved here from Hatchery) + the Link network (#17).
    this.commandCenter = new CommandCenter(this);

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
      // Remote expansion: three domain controllers (#18 C1/C2, multi-source #102).
      // Each OWNS its whole domain across all remotes — reserving, mining, hauling —
      // rather than splitting per source/room, so cross-room decisions (re-home a
      // miner when its room turns hot) live in one owner with full visibility. All
      // gate on health.expansionReady, which self-throttles the expansion.
      new ReserveOverlord(this), // one reserver per safe remote room
      new RemoteMiningOverlord(this), // one miner per safe remote source
      new RemoteWorkOverlord(this), // builds + maintains each remote source's container (#114)
      new RemoteLogisticsOverlord(this), // one shared fleet hauls them all home
      new GuardOverlord(this), // clears winnable threats in the remote footprint (#118)
      new DefenseOverlord(this), // places + operates towers (no-op until RCL3)
      new ScoutOverlord(this), // roams cheap scouts to keep map intel fresh (#142)
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

  // The energy budget to size a spawned creep's body against. Normally the full
  // spawn capacity — we wait for extensions to fill and spawn a big body. But while
  // RECOVERING (#54) the workforce has collapsed, so nothing is filling extensions
  // and energyAvailable is frozen at the spawn's own store; budgeting to capacity
  // would forever request a body we can't afford. Size to what we actually have, so
  // a cheap bootstrap worker spawns from the stranded energy and digs the colony out.
  spawnEnergyBudget() {
    return this.health.recovering
      ? this.room.energyAvailable
      : this.room.energyCapacityAvailable;
  }

  // Cost of the static miner the colony will request the instant it resumes
  // specialists (2b) — the bar recovery must clear before releasing, else 2b
  // re-requests an unaffordable body and respirals. Priced at the full cap (the
  // budget a healthy colony spawns it on); Miner owns the body recipe, Colony owns
  // the affordability question.
  staticMinerCost() {
    return bodyCost(Miner.bodyFor(this.room.energyCapacityAvailable));
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

  // The CommandCenter-planned links (#17), resolved from the cached layout to live
  // structures (null until built). The controller link is the upgrade receiver; the
  // source links are the LinkedMiner-fed senders.
  controllerLink() {
    return this.linkByRole("controller");
  }

  // The built source link for a given source id (the LinkedMiner transfers into it),
  // or null. Keyed by source so a per-source overlord/role can find its own link.
  sourceLink(sourceId) {
    const entry = this.linkEntries().find((e) => e.role === "source" && e.sourceId === sourceId);
    return entry ? this.linkAt(entry) : null;
  }

  // Every built source (sender) link — the senders CommandCenter.operateLinks drains.
  sourceLinks() {
    return this.linkEntries()
      .filter((e) => e.role === "source")
      .map((e) => this.linkAt(e))
      .filter(Boolean);
  }

  linkEntries() {
    return Memory.colonyData?.[this.name]?.linkPositions || [];
  }

  linkByRole(role) {
    const entry = this.linkEntries().find((e) => e.role === role);
    return entry ? this.linkAt(entry) : null;
  }

  // The live link structure on a cached layout tile, or null if not built yet. A
  // single-tile lookFor — cheap enough to skip per-tick memoization.
  linkAt(entry) {
    return (
      new RoomPosition(entry.x, entry.y, entry.roomName)
        .lookFor(LOOK_STRUCTURES)
        .find((s) => s.structureType === STRUCTURE_LINK) || null
    );
  }

  // Every remote source we can mine, value-ranked best-first (#102). One flat list
  // across all safe neighbours from the static map (#88): a source qualifies if its
  // room isn't reserved by someone else and the source is reachable with a finite
  // haul distance. Each entry carries its room geometry so a per-source mining
  // overlord and a per-room reserver can be built straight from it:
  //   { room, dir, x, y, dist, value, controller }
  //
  // Deliberately NOT filtered by live threat (Threat.isHot) — this is the stable
  // geometric set the overlords are built from, so a room flapping hot/cold never
  // adds/removes overlords (which would orphan their creeps). Hotness is handled
  // downstream: each overlord drops its desiredCount to 0 while its room is hot, and
  // an out-in-the-field creep retreats (reading the shared intel, #105). Memoized
  // per tick — it's pure over the static map, so it's cheap and deterministic.
  remoteSources() {
    if (this._remoteSources !== undefined) return this._remoteSources;
    const remotes = expansionMap[this.name]?.remotes || [];
    const out = [];
    for (const r of remotes) {
      if (r.reservedByOther) continue; // contested economy — not a free remote
      for (const s of r.sources || []) {
        if (!s.reachable || !isFinite(s.dist)) continue; // walled-off / bad dist
        out.push({
          room: r.room, dir: r.dir, x: s.x, y: s.y,
          dist: s.dist, value: s.value, controller: r.controller,
        });
      }
    }
    out.sort((a, b) => b.value - a.value); // best-first → highest-value source funds first
    this._remoteSources = out;
    return out;
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

    // 2. CommandCenter places Storage (before the extension spiral) + operates the
    //    link network; then the Hatchery fulfils the highest-priority spawn request.
    if (!lowBucket) {
      this.commandCenter.run();
      this.hatchery.run(spawnRequests);
    }
  }
}
