import { HiveCluster } from "./HiveCluster.js";
import { ExtensionPlanner } from "../lib/ExtensionPlanner.js";
import { RoadPlanner } from "../lib/RoadPlanner.js";
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
// candidates accumulate eagerly; the expansionReady gate decides WHEN to build.
const ROAD_THRESHOLD = 40;

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
  //  Roads: traffic-driven via a lazy heat map (#116). Creeps are sampled into a
  //  per-room heat pool (tile → count); a tile that crosses ROAD_THRESHOLD becomes
  //  a road. The hot paths emerge from where creeps actually walk (no hand-coded
  //  topology), and because movement prefers roads the network self-completes.
  //  Gated on 2b:Hauling (the routes go hot once haulers shuttle every tick);
  //  PLACEMENT is gated on expansionReady so a low threshold lets candidates
  //  accumulate and build only when the colony has slack. Workers build the sites.
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
    if (Game.time % ROAD_PLAN_INTERVAL === 0 && this.colony.health.expansionReady) {
      RoadPlanner.placeHotRoads(this.room, pool, ROAD_THRESHOLD);
    }
  }

  // Sampling cadence scales with health: keener when the colony has spare capacity
  // (expansionReady), lazier under load so traffic sampling never competes with
  // the core economy for CPU.
  roadSampleInterval() {
    return this.colony.health.expansionReady ? ROAD_SAMPLE_INTERVAL : ROAD_SAMPLE_INTERVAL * 3;
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
  //  Spawning: fulfil the highest-priority spawn request we can afford.
  // --------------------------------------------------------------------------
  spawnFromRequests(requests) {
    if (!requests || requests.length === 0) return;

    const freeSpawn = this.spawns.find((s) => !s.spawning);
    if (!freeSpawn) return;

    // Lowest priority number first.
    requests.sort((a, b) => a.priority - b.priority);
    const req = requests[0];

    const cost = bodyCost(req.body);
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
