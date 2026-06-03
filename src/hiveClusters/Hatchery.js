import { HiveCluster } from "./HiveCluster.js";
import { ExtensionPlanner } from "../lib/ExtensionPlanner.js";
import { RoadPlanner } from "../lib/RoadPlanner.js";
import { stageAtLeast } from "../lib/Stages.js";
import { log } from "../lib/Logger.js";
import { Hauler } from "../roles/Hauler.js";

// How often (ticks) to run the road backlog. Roads aren't urgent and the layout
// is cached, so a periodic sweep keeps steady-state CPU flat (no per-tick look()
// over the whole network) while still replacing the odd decayed road.
const ROAD_PLAN_INTERVAL = 25;

// ============================================================================
//  Hatchery — owns the colony's spawns + extensions; turns spawn requests
//  (from Overlords) into actual spawnCreep() calls, highest priority first, and
//  auto-places Extension construction sites as RCL unlocks them so spawn energy
//  capacity grows (300 → 550 at RCL2, and onward). Bigger bodies follow for
//  free: every overlord budgets its body on room.energyCapacityAvailable.
//
//  As the base's anchor it also plans the road network radiating from the spawn
//  (each source ↔ spawn, spawn ↔ controller) once hauling goes live — see
//  planRoads().
// ============================================================================
export class Hatchery extends HiveCluster {
  constructor(colony) {
    super(colony);
    this.spawns = colony.spawns;
  }

  // requests: [{ priority, role, body, memory }]
  run(requests) {
    this.planExtensions();
    // Roads after extensions: the layout weaves through the final base shape
    // (issue #14 — road planning depends on where the extensions land).
    this.planRoads();
    this.spawnFromRequests(requests);
  }

  // --------------------------------------------------------------------------
  //  Extension placement: keep extension construction sites alive on a stable
  //  checkerboard layout around the spawn, up to the current RCL cap. Workers
  //  (and later haulers) build and fill them — no new role needed.
  // --------------------------------------------------------------------------
  planExtensions() {
    const anchor = this.spawns[0];
    if (!anchor) return; // no spawn to anchor the layout (pre-bootstrap)

    const rcl = this.colony.controller.level;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] || {})[rcl] || 0;
    if (cap === 0) return; // extensions not unlocked yet (RCL < 2)

    ExtensionPlanner.ensureSites(this.room, this.extensionLayout(anchor), cap);
  }

  // The planned extension tiles, computed once via ExtensionPlanner and cached
  // in colony memory (mirrors MiningOverlord.miningPosition). The layout is
  // deterministic from terrain, so caching it keeps the spiral scan off the
  // per-tick CPU budget. We plan for the RCL8 maximum up front so the layout
  // never shifts as RCL climbs — only the cap we fill it to grows.
  extensionLayout(anchor) {
    const cached = this.extensionLayoutCache;
    if (cached) {
      return cached.map((p) => new RoomPosition(p.x, p.y, p.roomName));
    }
    // Plan a few candidates beyond the RCL8 extension cap so structures that
    // share the extension checkerboard colour (towers — see TowerPlanner) can
    // claim a tile without starving the layout: ensureSites skips occupied tiles
    // and falls through to the spares, so the full 60-extension cap is still
    // reachable at RCL8. Headroom = the RCL8 tower cap (the known competitor).
    const maxExtensions =
      CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][8] +
      CONTROLLER_STRUCTURES[STRUCTURE_TOWER][8];
    const planned = ExtensionPlanner.planPositions(this.room, anchor.pos, maxExtensions);
    this.extensionLayoutCache = planned.map((p) => ({
      x: p.x,
      y: p.y,
      roomName: p.roomName,
    }));
    return planned;
  }

  get extensionLayoutCache() {
    return Memory.colonyData?.[this.colony.name]?.extensionPositions;
  }

  set extensionLayoutCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].extensionPositions = value;
  }

  // --------------------------------------------------------------------------
  //  Road placement: keep road construction sites alive along the hot paths
  //  (each source ↔ spawn, spawn ↔ controller). Gated on 2b:Hauling — that's
  //  when those routes go hot (haulers are now shuttling container → spawn and
  //  container → controller every tick). Workers build the sites.
  // --------------------------------------------------------------------------
  planRoads() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return;
    // Roads are a slow, low-priority backlog and the layout is cached, so there's
    // no need to sweep the network every tick. Scanning periodically keeps the
    // per-tick cost flat once the roads are built, and still re-places any road
    // that fully decayed (workers normally repair them long before that).
    if (Game.time % ROAD_PLAN_INTERVAL !== 0) return;
    const anchor = this.spawns[0];
    if (!anchor) return; // no spawn to anchor the network (pre-bootstrap)

    RoadPlanner.ensureSites(this.room, this.roadLayout(anchor));
  }

  // The planned road tiles, computed once via RoadPlanner and cached in colony
  // memory (mirrors extensionLayout). The route is deterministic from terrain +
  // the container/spawn/controller endpoints, so caching keeps the PathFinder
  // runs off the per-tick budget. We only cache once the controller endpoint is
  // settled (its container site/structure exists) so the cached route lands on
  // the upgraders' real parking tile rather than a pre-container fallback.
  roadLayout(anchor) {
    const cached = this.roadLayoutCache;
    if (cached) return cached;
    const { legs, final } = this.roadLegs(anchor);
    const planned = RoadPlanner.planTiles(this.room, legs);
    if (final) this.roadLayoutCache = planned; // [{ x, y }]
    return planned;
  }

  // The { from, to } endpoint pairs for the road network, plus whether EVERY
  // endpoint is settled (so roadLayout knows if the result is safe to cache).
  // Endpoints are discovered from room state — the source containers (where
  // haulers load) and the controller container (where they deliver) — so roads
  // land on the tiles creeps actually walk, with graceful fallback to the
  // source/controller themselves before their containers exist.
  //
  // Stage 2b begins as soon as ANY one source container is finished, so a second
  // source's container may not exist yet. We only report `final` (cache the
  // layout) once all of them AND the controller are settled — otherwise the
  // cached route would bake in a source.pos fallback that never updates to the
  // real container↔spawn hot path.
  roadLegs(anchor) {
    const spawnPos = anchor.pos;
    const controllerEnd = this.controllerRoadEndpoint();
    const sourceEnds = this.colony.sources.map((s) => this.sourceRoadEndpoint(s));
    const legs = sourceEnds.map((end) => ({ from: end.pos, to: spawnPos }));
    legs.push({ from: spawnPos, to: controllerEnd.pos });
    const final = controllerEnd.settled && sourceEnds.every((e) => e.settled);
    return { legs, final };
  }

  // Where a source leg ends: the source's container (the hauler's load tile) if
  // its structure OR site exists yet, else the source itself. The source
  // container hugs the source, so range 1 finds it.
  sourceRoadEndpoint(source) {
    return this.containerEndpoint(source.pos, source.pos, 1);
  }

  // Where the controller leg ends: the controller container (the hauler's
  // delivery / upgrader parking tile) if its structure OR site exists yet, else
  // the controller. Unlike a source container, this one sits TWO tiles short of
  // the controller (ContainerPlanner.controllerContainerTile), so we search
  // range 3 and exclude source containers — matching how Hauler identifies it.
  // Without the wider range the endpoint would never settle, the road layout
  // would never cache, and the road would keep targeting the controller tile
  // instead of the real drop-off.
  controllerRoadEndpoint() {
    const ctrl = this.colony.controller;
    return this.containerEndpoint(
      ctrl.pos,
      ctrl.pos,
      3,
      (s) => !Hauler.isSourceContainer(s, this.colony)
    );
  }

  // A road endpoint that prefers the container near `anchorPos` (built structure
  // first, then its construction site) within `range`, optionally narrowed by
  // `extraFilter`, and falls back to `fallbackPos`. Returns { pos, settled }:
  // settled flags that the container exists, so the route through this endpoint
  // is its final hot path and safe to cache.
  containerEndpoint(anchorPos, fallbackPos, range, extraFilter = null) {
    const isContainer = (s) =>
      s.structureType === STRUCTURE_CONTAINER && (!extraFilter || extraFilter(s));
    const built = anchorPos.findInRange(FIND_STRUCTURES, range, {
      filter: isContainer,
    })[0];
    if (built) return { pos: built.pos, settled: true };
    const site = anchorPos.findInRange(FIND_CONSTRUCTION_SITES, range, {
      filter: isContainer,
    })[0];
    if (site) return { pos: site.pos, settled: true };
    return { pos: fallbackPos, settled: false };
  }

  get roadLayoutCache() {
    return Memory.colonyData?.[this.colony.name]?.roadPositions;
  }

  set roadLayoutCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].roadPositions = value;
  }

  // --------------------------------------------------------------------------
  //  Spawning: fulfil the highest-priority spawn request we can afford.
  // --------------------------------------------------------------------------
  spawnFromRequests(requests) {
    if (!requests || requests.length === 0) return;

    const freeSpawn = this.spawns.find((s) => !s.spawning);
    if (!freeSpawn) return;

    // Lowest priority number first.
    requests.sort((a, b) => a.priority - b.priority);
    const req = requests[0];

    const cost = req.body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    if (cost > this.room.energyAvailable) {
      // Not enough energy yet — wait (unless we have zero creeps: emergency).
      const totalCreeps = Object.keys(Game.creeps).length;
      if (totalCreeps > 0) return;
    }

    const name = `${req.role}_${Game.time % 10000}`;
    const result = freeSpawn.spawnCreep(req.body, name, { memory: req.memory });

    if (result === OK) {
      log.info(`[${this.colony.name}] spawning ${name} (${req.body.length} parts, cost ${cost})`);
    } else if (result !== ERR_NOT_ENOUGH_ENERGY && result !== ERR_BUSY) {
      log.warn(`[${this.colony.name}] spawn ${req.role} failed: ${result}`);
    }
  }
}
