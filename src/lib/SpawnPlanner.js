import { log } from "./Logger.js";

// ============================================================================
//  SpawnPlanner — places a colony's spawns: the FIRST spawn for a freshly-claimed
//  colony (#220), AND additional spawns as RCL unlocks them (#22 — a 2nd at RCL7,
//  a 3rd at RCL8). Generic to the spawn count: the Hatchery drives it off the RCL
//  cap (CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][rcl]), so there's no hardcoded "2nd".
//
//  There's no full base-layout planner yet, so each spawn tile is picked live from
//  terrain + game state (CLAUDE.md: compute positions, never hardcode): an open tile
//  roughly central to the room's sources and controller, with a clear 3×3 (elbow room
//  for the extension checkerboard the Hatchery grows around it). Additional spawns are
//  kept SEPARATED from the existing spawns so they spread across the base — redundancy
//  if one is destroyed, and unobstructed creep egress for parallel spawning. The choice
//  is cached per slot in colony memory (deterministic from static geometry) so the
//  search runs once. Reference bots (Overmind/hivemind) bake spawn tiles into a fixed
//  base template; lacking one, we approximate that "planned, separated slot" with this
//  centroid + separation search.
//
//  Mirrors the other planners (ContainerPlanner/ExtensionPlanner): geometry here,
//  the owning HiveCluster handles the per-tick lifecycle.
// ============================================================================

// Half-width of the search window around the served-objects centroid. The spawn
// wants to sit amid the things it serves; a ±RADIUS box around their centre holds
// plenty of candidates without scanning the whole 50×50 room on every claim.
const SEARCH_RADIUS = 10;

// Additional spawns sit MORE than this range from every existing spawn, so the spawns
// spread across the base (redundancy + each gets its own open egress tiles for parallel
// spawning) instead of clustering and sharing a congested exit.
const SPAWN_SEPARATION = 2;

export const SpawnPlanner = {
  // Keep spawn construction sites alive up to the RCL cap: place the FIRST spawn for a spawnless
  // colony, then an additional spawn whenever the cap rises (RCL7→2, RCL8→3). One site per call (the
  // next slot); no-op once built + queued reaches the cap. Safe to call every tick — it only does real
  // work while below the cap (the brief windows after founding and after an RCL milestone).
  ensureSpawns(room, cap) {
    if (cap <= 0) return;
    const spawns = room.find(FIND_MY_SPAWNS);
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_SPAWN,
    });
    if (spawns.length + sites.length >= cap) return; // at the cap — nothing to place

    const taken = [...spawns.map((s) => s.pos), ...sites.map((s) => s.pos)];
    const anchor = this.nextTile(room, taken);
    if (!anchor) return; // no buildable tile found (compute() logged it)
    const result = room.createConstructionSite(anchor, STRUCTURE_SPAWN);
    if (result === ERR_INVALID_TARGET) {
      // The cached tile turned unbuildable (a road/structure/site landed on it since we picked it) —
      // else we'd retry it fruitlessly every tick. Drop this slot's cache so compute() re-picks next tick.
      this.dropCache(room, taken.length);
      return;
    }
    // ERR_FULL (100-site global cap) / ERR_RCL_NOT_ENOUGH (cap-gated, shouldn't fire) are
    // expected/transient — only log a genuinely unexpected failure.
    if (result !== OK && result !== ERR_FULL && result !== ERR_RCL_NOT_ENOUGH) {
      log.warn(`[${room.name}] spawn site at ${anchor} failed: ${result}`);
    }
  },

  // The next spawn tile, given the tiles already taken by built spawns + spawn sites. Cached per slot
  // (slot index = how many spawns/sites already exist), so the search runs once per slot. Slot 0 (a
  // founding colony) is the centroid-best tile; later slots are the best tile separated from the
  // existing spawns. For the home colony — spawn[0] placed manually at game start — slot 0 is never
  // computed (a spawn already exists), so the first computed slot is the RCL7 2nd spawn.
  nextTile(room, taken) {
    const slot = taken.length;
    const cached = Memory.colonyData?.[room.name]?.spawnAnchors?.[slot];
    if (cached) {
      const pos = new RoomPosition(cached.x, cached.y, room.name);
      // Re-validate against the CURRENT spawns, not just buildability: if a spawn was
      // destroyed/rebuilt elsewhere the cached tile could now sit too close to one, so re-check the
      // separation it was chosen for and recompute if it's stale.
      const separated = taken.every((p) => p.getRangeTo(pos) > SPAWN_SEPARATION);
      if (separated && this.buildable(room, pos.x, pos.y)) return pos;
    }
    const pos = this.compute(room, taken);
    if (pos) {
      Memory.colonyData ||= {};
      Memory.colonyData[room.name] ||= {};
      (Memory.colonyData[room.name].spawnAnchors ||= {})[slot] = {
        x: pos.x,
        y: pos.y,
        roomName: room.name,
      };
    }
    return pos;
  },

  // Forget a slot's cached tile (it turned unbuildable) so the next tick re-computes a clear one.
  dropCache(room, slot) {
    const anchors = Memory.colonyData?.[room.name]?.spawnAnchors;
    if (anchors) delete anchors[slot];
  },

  // Pick the open tile nearest the centroid of (sources + controller) that has a clear 3×3 around it
  // (room for the spawn + its first extensions), isn't hugging a source or the controller (those tiles
  // are reserved for mining / upgrading), and is well clear of any spawn already placed (so additional
  // spawns spread). Scored by summed range to the served objects so the spawn sits central and the
  // hauls/fills stay short.
  compute(room, taken = []) {
    const terrain = room.getTerrain();
    const served = [...room.find(FIND_SOURCES), room.controller].filter(Boolean);
    if (!served.length) return null;
    const cx = Math.round(served.reduce((s, o) => s + o.pos.x, 0) / served.length);
    const cy = Math.round(served.reduce((s, o) => s + o.pos.y, 0) / served.length);

    let best = null;
    let bestScore = Infinity;
    for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 2 || x > 47 || y < 2 || y > 47) continue; // keep off the exit borders
        if (!this.clear3x3(terrain, x, y)) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (served.some((o) => o.pos.getRangeTo(pos) <= 2)) continue; // don't crowd them
        if (taken.some((p) => p.getRangeTo(pos) <= SPAWN_SEPARATION)) continue; // spread the spawns
        if (!this.buildable(room, x, y)) continue; // terrain-clear but occupied (road/structure/site)
        const score = served.reduce((s, o) => s + o.pos.getRangeTo(pos), 0);
        if (score < bestScore) {
          bestScore = score;
          best = pos;
        }
      }
    }
    if (!best) log.warn(`[${room.name}] SpawnPlanner found no clear spawn tile (slot ${taken.length})`);
    return best;
  },

  // Is the anchor tile actually buildable for a spawn? Terrain-clear is necessary but
  // not sufficient — a leftover road/structure or an existing construction site (a
  // claimed room may carry remnants) makes createConstructionSite return
  // ERR_INVALID_TARGET. A rampart is fine (a spawn can sit under one). Checked only on
  // the handful of terrain-clear candidates, so the lookForAt cost stays bounded.
  buildable(room, x, y) {
    const blocked = room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .some((s) => s.structureType !== STRUCTURE_RAMPART);
    if (blocked) return false;
    return room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length === 0;
  },

  // Is the 3×3 block centred on (x,y) all non-wall terrain? Gives the spawn its own
  // tile plus the immediate ring the extension checkerboard needs to start.
  clear3x3(terrain, x, y) {
    for (let yy = y - 1; yy <= y + 1; yy++) {
      for (let xx = x - 1; xx <= x + 1; xx++) {
        if (terrain.get(xx, yy) === TERRAIN_MASK_WALL) return false;
      }
    }
    return true;
  },
};
