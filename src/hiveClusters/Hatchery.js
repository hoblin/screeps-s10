import { HiveCluster } from "./HiveCluster.js";
import { ExtensionPlanner } from "../lib/ExtensionPlanner.js";
import { RoadPlanner } from "../lib/RoadPlanner.js";
import { SpawnPlanner } from "../lib/SpawnPlanner.js";
import { stageAtLeast } from "../lib/Stages.js";
import { log } from "../lib/Logger.js";
import { roleIcon } from "../lib/Icons.js";
import { bodyCost } from "../lib/BodyGenerator.js";

// How often (ticks) to place roads from the traffic heat map. Roads aren't urgent
// and placement is gated on spare capacity, so a periodic sweep keeps steady-state
// CPU flat while still refilling the backlog and replacing the odd decayed road.
const ROAD_PLAN_INTERVAL = 25;
// How often (ticks) to sample creep positions into the heat pool. The cadence is
// health-elastic (see roadSampleInterval): keener when the colony has slack,
// lazier under load so traffic sampling never competes with the core for CPU.
const ROAD_SAMPLE_INTERVAL = 5;
// Samples a tile must accumulate before it becomes a road. Deliberately LOW so
// candidates accumulate eagerly; the roadBuildReady gate decides WHEN to build.
const ROAD_THRESHOLD = 20;

// ============================================================================
//  Hatchery — owns the colony's spawns + extensions; turns spawn requests
//  (from Overlords) into actual spawnCreep() calls, highest priority first, and
//  auto-places Extension construction sites as RCL unlocks them so spawn energy
//  capacity grows (300 → 550 at RCL2, and onward). Bigger bodies follow for
//  free: every overlord budgets its body on room.energyCapacityAvailable.
//
//  As the base's anchor it also drives the traffic-driven road network — sampling
//  where creeps actually walk into a heat map and roading the hottest tiles once
//  hauling goes live — see planRoads() (#116).
// ============================================================================
export class Hatchery extends HiveCluster {
  constructor(colony) {
    super(colony);
    this.spawns = colony.spawns;
  }

  // requests: [{ priority, role, body, memory }]
  // Storage is placed by the CommandCenter (run just before us in Colony.run), so its
  // central tile is already claimed when the extension spiral (which skips occupied
  // tiles) lays down around it (#16/#17).
  run(requests) {
    // Place spawn sites up to the RCL cap: the first spawn for a freshly-claimed colony (#220), then
    // additional spawns as RCL unlocks them (#22 — a 2nd at RCL7, a 3rd at RCL8). Generic to N via the
    // cap; no-op once built + queued reaches it, so it only works during the brief sub-cap windows.
    this.ensureSpawns();
    this.planExtensions();
    // Roads after extensions: sampling excludes the structure-checkerboard tiles,
    // so roads land on the walkways the extension spiral leaves open (#116).
    this.planRoads();
    this.spawnFromRequests(requests);
    this.drawSpawnLabels();
  }

  // Show the incoming creep's role icon over each spawning spawn (#123) — so we can
  // see who's being produced before it pops, mirroring the per-creep action icons.
  drawSpawnLabels() {
    for (const spawn of this.spawns) {
      if (!spawn.spawning) continue;
      const role = Game.creeps[spawn.spawning.name]?.memory.role;
      this.room.visual.text(roleIcon(role), spawn.pos.x, spawn.pos.y - 0.9, { font: 0.7, opacity: 0.8 });
    }
  }

  // --------------------------------------------------------------------------
  //  Spawn placement: keep spawn sites alive up to the RCL cap (SpawnPlanner picks
  //  the tiles + caches them). The first spawn for a founded colony, plus the RCL7
  //  2nd and RCL8 3rd (#22) — driven off the cap, no hardcoded count.
  // --------------------------------------------------------------------------
  ensureSpawns() {
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_SPAWN] || {})[this.colony.controller.level] || 0;
    SpawnPlanner.ensureSpawns(this.room, cap);
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
    // share the extension checkerboard colour can claim a tile without starving
    // the layout: ensureSites skips occupied tiles and falls through to the spares,
    // so the full 60-extension cap is still reachable at RCL8. Headroom = the known
    // competitors that may land on a layout tile — the RCL8 towers (6) plus the RCL7/8
    // additional spawns (#22; the anchor spawn is separate, so SPAWN[8]−1 of them).
    const maxExtensions =
      CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][8] +
      CONTROLLER_STRUCTURES[STRUCTURE_TOWER][8] +
      (CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][8] - 1);
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
  //  Roads: traffic-driven via a lazy heat map (#116). Creeps are sampled into a
  //  per-room heat pool (tile → count); a tile that crosses ROAD_THRESHOLD becomes
  //  a road. The hot paths emerge from where creeps actually walk (no hand-coded
  //  topology), and because movement prefers roads the network self-completes.
  //  Gated on 2b:Hauling (the routes go hot once haulers shuttle every tick);
  //  PLACEMENT is gated on roadBuildReady (energy headroom, NOT spawn-idle — a road
  //  costs energy + worker time, not spawn time, #135) so a low threshold lets
  //  candidates accumulate and build whenever income outpaces the spawn. Workers
  //  build the sites.
  // --------------------------------------------------------------------------
  planRoads() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return;
    const anchor = this.spawns[0];
    if (!anchor) return; // no spawn to anchor the parity / pre-bootstrap

    const pool = this.roadHeatPool();
    // Sample traffic on a health-elastic cadence (cheap; mutates the live pool).
    if (Game.time % this.roadSampleInterval() === 0) {
      RoadPlanner.record(this.room, pool, anchor.pos);
    }
    // Build the hottest tiles only when we can afford the lowest-priority backlog.
    if (Game.time % ROAD_PLAN_INTERVAL === 0 && this.colony.health.roadBuildReady) {
      RoadPlanner.placeHotRoads(this.room, pool, ROAD_THRESHOLD);
    }
  }

  // Sampling cadence scales with health: keener when we have the energy headroom to
  // road-build (roadBuildReady), lazier under load so traffic sampling never competes
  // with the core economy for CPU.
  roadSampleInterval() {
    return this.colony.health.roadBuildReady ? ROAD_SAMPLE_INTERVAL : ROAD_SAMPLE_INTERVAL * 3;
  }

  // The live per-room traffic heat pool (tile "x,y" → count), persisted in colony
  // memory (Colony is rebuilt every tick). Returns the live object so callers
  // mutate Memory directly — mirrors the miningPos cache keying.
  roadHeatPool() {
    Memory.colonyData ||= {};
    (Memory.colonyData[this.colony.name] ||= {}).roadHeat ||= {};
    return Memory.colonyData[this.colony.name].roadHeat;
  }

  // --------------------------------------------------------------------------
  //  Spawning: drain the priority queue across ALL idle spawns in parallel — with
  //  N spawns (RCL7→2, RCL8→3) the N highest-priority affordable requests are born
  //  the same tick, not serialised through one spawn (#22, the actual throughput
  //  fix; the extra structure is inert without it — Overmind's handleSpawns model).
  //
  //  Highest priority HOLDS the queue: if the top request we haven't placed yet is
  //  unaffordable, we stop — idle spawns wait for it rather than spawn a cheaper,
  //  lower-priority creep ahead of it (the same gate the single-spawn version had).
  //  The engine debits the shared room energy per spawnCreep, so room.energyAvailable
  //  falls as we go and a later spawn this tick correctly sees the reduced pool.
  // --------------------------------------------------------------------------
  spawnFromRequests(requests) {
    if (!requests || requests.length === 0) return;
    const idle = this.spawns.filter((s) => !s.spawning);
    if (!idle.length) return;

    requests.sort((a, b) => a.priority - b.priority); // lowest number = highest priority first
    const haveCreeps = Object.keys(Game.creeps).length > 0;

    let next = 0; // index of the next request to place
    for (let si = 0; si < idle.length && next < requests.length; si++) {
      const req = requests[next];
      const cost = bodyCost(req.body);
      // Can't afford the top remaining request — hold this and every other idle spawn for it (don't
      // skip to a cheaper lower-priority creep). The zero-creeps case is the extinction emergency:
      // attempt anyway (spawnCreep then fails cleanly if the body is truly unaffordable).
      if (cost > this.room.energyAvailable && haveCreeps) break;

      // Unique name even when two spawns fire the same tick (same role → same Game.time would collide).
      const name = `${req.role}_${Game.time % 10000}_${si}`;
      const result = idle[si].spawnCreep(req.body, name, { memory: req.memory });
      if (result === OK) {
        log.info(`[${this.colony.name}] spawning ${name} (${req.body.length} parts, cost ${cost})`);
        next++; // request placed — the next idle spawn takes the next request
      } else if (result === ERR_NOT_ENOUGH_ENERGY) {
        break; // engine says no energy (e.g. an earlier spawn this tick drained the pool) — hold
      } else if (result !== ERR_BUSY) {
        // ERR_BUSY shouldn't happen (we filtered !spawning); anything else is a bad request —
        // skip it so it can't wedge the whole queue every tick.
        log.warn(`[${this.colony.name}] spawn ${req.role} failed: ${result}`);
        next++;
      }
    }
  }
}
