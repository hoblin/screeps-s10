import { log } from "./Logger.js";

// ============================================================================
//  RoadPlanner — traffic-driven roads via a lazy heat map (#116).
//
//  Roads are drawn where creeps ACTUALLY walk, not from a hand-coded topology.
//  Creeps are sampled into a per-room heat pool (tile → count); a tile whose
//  count crosses ROAD_THRESHOLD becomes a road. Because movement prefers roads
//  (road cost 1 vs plain 2 / swamp 5), the first dots drawn on a corridor pull
//  creeps onto it, so the connecting tiles heat up and the path knits itself
//  together — we seed the hottest points and the network self-completes.
//
//  Pure geometry + lifecycle, mirroring ExtensionPlanner/ContainerPlanner: the
//  owning Hatchery holds the pool (Memory.colonyData) and the stage/health gates;
//  this lib only samples, prunes, and places. Forgetting happens two ways: the steady
//  prune caps accumulation at HEAT_POOL_MAX each sample, and — the key one — every time
//  roads commit we hard-reset the pool to the hottest HEAT_POOL_KEEP survivors, dropping
//  the incidental-traffic tail so only proven corridors ever seed a road.
// ============================================================================

// How many road construction sites we keep queued at once. Roads are a long,
// low-priority backlog (workers build them after extensions); refilled in waves.
const MAX_PENDING_ROAD_SITES = 10;
// Candidate-pool cap = the Memory bound. Only the hottest tiles survive a prune.
const HEAT_POOL_MAX = 100;
// On each placement WAVE the pool is hard-trimmed to the hottest HEAT_POOL_KEEP tiles,
// dropping the rest as incidental noise (#135). Roads must seed ONLY on proven
// corridors: if weak, randomly-walked tiles were left to slowly creep to threshold,
// we'd place scattered dots and creeps would route jaggedly between them — a non-optimal
// network. After a commit, the next accumulation cycle re-heats whatever the NEW roads
// route creeps onto, so the network grows as one coherent desire-line. Sized to the wave
// so we retain just the next wave's seeds.
const HEAT_POOL_KEEP = MAX_PENDING_ROAD_SITES;
// Roads follow the FREIGHT highways: only haulers (home + remote) define the heat —
// they are the loaded, constant traffic roads actually pay off for. Static miners
// (parked on a post), parked upgraders, and roaming workers would just pollute the
// map with traffic that doesn't need roading (#135).
const HAUL_ROLES = new Set(["hauler", "remoteHauler"]);

export const RoadPlanner = {
  key(x, y) {
    return `${x},${y}`;
  },

  // True if `pos` already holds something that blocks a new road. A road may share
  // a tile only with a rampart; every other structure — including an existing road
  // — blocks it, as does any construction site. (Same test as ExtensionPlanner.)
  occupied(pos) {
    return pos.look().some(
      (item) =>
        (item.type === LOOK_STRUCTURES &&
          item.structure.structureType !== STRUCTURE_RAMPART) ||
        item.type === LOOK_CONSTRUCTION_SITES
    );
  },

  // Sample one tick of HAULER traffic into `pool` (only haul roles count — see
  // HAUL_ROLES). Only WALKWAY tiles are eligible — the structure checkerboard
  // ((x+y)%2 === the spawn anchor's parity) is reserved for extensions/towers, so a
  // road must never squat it (mirrors ExtensionPlanner's parity). Tiles already
  // carrying a road/structure are skipped (nothing to plan). Prunes afterwards so the
  // pool stays bounded at HEAT_POOL_MAX.
  record(room, pool, anchor) {
    const parity = (anchor.x + anchor.y) % 2;
    for (const creep of room.find(FIND_MY_CREEPS)) {
      if (creep.spawning) continue;
      if (!HAUL_ROLES.has(creep.memory.role)) continue; // roads follow the freight highways (#135)
      const { x, y } = creep.pos;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue; // exit/border tile — no structure fits
      if ((x + y) % 2 === parity) continue; // structure-colour tile → not a road tile
      if (this.occupied(creep.pos)) continue; // already built/queued here
      const k = this.key(x, y);
      pool[k] = (pool[k] || 0) + 1;
    }
    this.prune(pool);
  },

  // Keep only the `keep` hottest tiles; drop the low-count tail. This IS the forgetting
  // mechanism: noise never accumulates into a road because it's culled (and restarts
  // from 0) long before reaching the threshold. Two uses: the steady accumulation cap
  // (HEAT_POOL_MAX, each sample) and the aggressive post-placement reset (HEAT_POOL_KEEP).
  prune(pool, keep = HEAT_POOL_MAX) {
    const keys = Object.keys(pool);
    if (keys.length <= keep) return;
    const top = new Set(keys.sort((a, b) => pool[b] - pool[a]).slice(0, keep));
    for (const k of keys) if (!top.has(k)) delete pool[k];
  },

  // Place roads on tiles whose traffic crossed `threshold`, hottest first, up to
  // the pending-site cap. A tile that's now occupied (already roaded) or that we
  // successfully queue is dropped from the pool so it stops holding a slot;
  // cap-blocked tiles stay and retry next pass. Non-OK results are logged, never
  // thrown (Screeps caps / RCL gating).
  placeHotRoads(room, pool, threshold, maxPending = MAX_PENDING_ROAD_SITES) {
    const pending = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    }).length;
    let budget = maxPending - pending;

    const hot = Object.keys(pool)
      .filter((k) => pool[k] >= threshold)
      .sort((a, b) => pool[b] - pool[a]);

    let placed = 0;
    for (const k of hot) {
      const [x, y] = k.split(",").map(Number);
      const pos = new RoomPosition(x, y, room.name);
      if (this.occupied(pos)) {
        delete pool[k]; // already roaded / blocked → stop tracking it
        continue;
      }
      if (budget <= 0) continue; // keep it queued in the pool; retry when the cap frees

      const result = room.createConstructionSite(pos, STRUCTURE_ROAD);
      if (result === OK) {
        delete pool[k]; // committed → stop holding a top-X slot
        budget--;
        placed++;
      } else if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        // Global site cap or RCL too low — no further tile can succeed this tick.
        log.warn(`[${room.name}] road site failed: ${result}`);
        break;
      } else if (result === ERR_INVALID_TARGET) {
        delete pool[k]; // un-buildable tile (e.g. a border tile that slipped in) → stop retrying
      } else {
        log.warn(`[${room.name}] road site at ${pos} failed: ${result}`);
      }
    }

    // A road just committed → this corridor is proven. Hard-trim the pool to the hottest
    // survivors and drop the long tail of incidental tiles, so noise can't creep to
    // threshold and seed scattered, non-optimal roads. The next cycle re-heats whatever
    // the new roads route creeps onto, growing the network as one desire-line (#135).
    if (placed > 0) this.prune(pool, HEAT_POOL_KEEP);
  },
};
