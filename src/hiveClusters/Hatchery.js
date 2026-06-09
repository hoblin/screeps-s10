import { HiveCluster } from "./HiveCluster.js";
import { RoomPlanner } from "../lib/RoomPlanner.js";
import { StructureRealizer } from "../lib/StructureRealizer.js";
import { stageAtLeast } from "../lib/Stages.js";
import { log } from "../lib/Logger.js";
import { roleIcon } from "../lib/Icons.js";
import { bodyCost } from "../lib/BodyGenerator.js";

// How often (ticks) to refill the road backlog from the plan. Roads aren't urgent
// and placement is gated on spare capacity, so a periodic sweep keeps steady-state
// CPU flat while still refilling the backlog and replacing the odd decayed road.
const ROAD_PLAN_INTERVAL = 25;
// How many road construction sites we keep queued at once. Roads are a long,
// low-priority backlog (workers build them after extensions); refilled in waves.
const MAX_PENDING_ROAD_SITES = 10;

// ============================================================================
//  Hatchery — owns the colony's spawns + extensions; turns spawn requests
//  (from Overlords) into actual spawnCreep() calls, highest priority first, and
//  auto-places Extension construction sites as RCL unlocks them so spawn energy
//  capacity grows (300 → 550 at RCL2, and onward). Bigger bodies follow for
//  free: every overlord budgets its body on room.energyCapacityAvailable.
//
//  Spawns, extensions and the road network all come from the unified RoomPlanner
//  (#258): the Hatchery just realizes its slice of the cached layout, gated by RCL
//  (spawns/extensions) and 2b:Hauling + roadBuildReady (roads).
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
    // Realize the planned spawns up to the RCL cap: the first spawn for a freshly-claimed colony
    // (#220, at the plan's anchor tile), then the RCL7 2nd / RCL8 3rd (#22). No-op once built +
    // queued reaches the cap, so it only works during the brief sub-cap windows.
    this.ensureSpawns();
    this.planExtensions();
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
  //  Spawn placement: realize the planned spawn tiles up to the RCL cap. Slot 0 is
  //  the base anchor (built manually on the home room, by a founding pioneer on an
  //  expansion room); slots 1/2 are the RCL7 2nd and RCL8 3rd spawn (#22). Driven
  //  off the cap, no hardcoded count.
  // --------------------------------------------------------------------------
  ensureSpawns() {
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_SPAWN] || {})[this.colony.controller.level] || 0;
    StructureRealizer.ensureSites(this.room, STRUCTURE_SPAWN, RoomPlanner.tilesFor(this.colony, STRUCTURE_SPAWN), cap);
  }

  // --------------------------------------------------------------------------
  //  Extension placement: realize the planned extension tiles up to the current
  //  RCL cap. Workers (and later haulers) build and fill them — no new role needed.
  // --------------------------------------------------------------------------
  planExtensions() {
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] || {})[this.colony.controller.level] || 0;
    if (cap === 0) return; // extensions not unlocked yet (RCL < 2)
    StructureRealizer.ensureSites(this.room, STRUCTURE_EXTENSION, RoomPlanner.tilesFor(this.colony, STRUCTURE_EXTENSION), cap);
  }

  // --------------------------------------------------------------------------
  //  Roads: realize the planned road network (#258 — swamp-neutral spine + access
  //  lanes, computed at founding) in low-priority waves. Gated on 2b:Hauling (the
  //  freight routes matter once haulers shuttle) and roadBuildReady (energy headroom,
  //  NOT spawn-idle — a road costs energy + worker time, #135). Workers build the sites.
  // --------------------------------------------------------------------------
  planRoads() {
    if (!stageAtLeast(this.colony, "2b:Hauling")) return;
    if (Game.time % ROAD_PLAN_INTERVAL !== 0) return; // periodic backlog refill
    if (!this.colony.health.roadBuildReady) return; // can't afford the lowest-priority backlog yet
    // Roads have no RCL count cap, so the budget is driven ONLY by maxPending — NOT by
    // total built roads (a cap of planned-count would subtract legacy/off-plan roads and
    // could starve the spine to zero in an established colony). Already-built/queued plan
    // tiles are skipped via the occupancy check, so we never double-place.
    const roads = RoomPlanner.roads(this.colony);
    StructureRealizer.ensureSites(this.room, STRUCTURE_ROAD, roads, Infinity, {
      maxPending: MAX_PENDING_ROAD_SITES,
    });
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

      // Globally-unique name: the colony name disambiguates across colonies (two rooms spawning the
      // same role the same tick), `si` across the room's own spawns that tick, Game.time across ticks.
      // Role stays the first "_"-segment so offline tooling (bin/sapi map) still reads it from the name.
      const name = `${req.role}_${this.colony.name}_${Game.time % 10000}_${si}`;
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
