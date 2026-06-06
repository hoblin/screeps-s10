import { log } from "./Logger.js";

// ============================================================================
//  SpawnPlanner — places a freshly-claimed colony's FIRST spawn (#220).
//
//  A claimed room has a controller but no spawn; the pioneers that bootstrap it
//  need a spawn construction site to build. There's no full base-layout planner
//  yet, so this picks a single sensible anchor live from terrain + game state
//  (CLAUDE.md: compute positions, never hardcode): an open tile roughly central to
//  the room's sources and controller, with elbow room for the extension
//  checkerboard the Hatchery later grows around it. The choice is cached in colony
//  memory (deterministic from static geometry) so the search runs once.
//
//  Mirrors the other planners (ContainerPlanner/ExtensionPlanner): geometry here,
//  the owning HiveCluster handles the per-tick lifecycle.
// ============================================================================

// Half-width of the search window around the served-objects centroid. The spawn
// wants to sit amid the things it serves; a ±RADIUS box around their centre holds
// plenty of candidates without scanning the whole 50×50 room on every claim.
const SEARCH_RADIUS = 10;

export const SpawnPlanner = {
  // Keep the first spawn's construction site alive until it's built; no-op once a
  // spawn (or its site) already exists. Safe to call every tick for a spawnless
  // owned room — it only does real work during the brief bootstrap window.
  ensureFirstSpawn(room) {
    if (room.find(FIND_MY_SPAWNS).length > 0) return; // already has a spawn
    const hasSite = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_SPAWN,
    }).length > 0;
    if (hasSite) return; // site already placed — let the pioneers build it

    const anchor = this.anchor(room);
    if (!anchor) return; // no buildable tile found (compute() logged it)
    const result = room.createConstructionSite(anchor, STRUCTURE_SPAWN);
    // ERR_FULL (100-site global cap) / ERR_RCL_NOT_ENOUGH (>1 spawn before RCL7) are
    // expected/transient — only log a genuinely unexpected failure.
    if (result !== OK && result !== ERR_FULL && result !== ERR_RCL_NOT_ENOUGH) {
      log.warn(`[${room.name}] first-spawn site at ${anchor} failed: ${result}`);
    }
  },

  // The chosen anchor tile (cached). Computed once from static geometry, then read
  // back from colony memory — same Memory.colonyData pattern the other planners use.
  anchor(room) {
    const cached = Memory.colonyData?.[room.name]?.spawnAnchor;
    if (cached) return new RoomPosition(cached.x, cached.y, room.name);
    const pos = this.compute(room);
    if (pos) {
      Memory.colonyData ||= {};
      (Memory.colonyData[room.name] ||= {}).spawnAnchor = {
        x: pos.x,
        y: pos.y,
        roomName: room.name,
      };
    }
    return pos;
  },

  // Pick the open tile nearest the centroid of (sources + controller) that has a
  // clear 3×3 around it (room for the spawn + its first extensions) and isn't hugging
  // a source or the controller (those tiles are reserved for mining / upgrading).
  // Scored by summed range to the served objects so the spawn sits central and the
  // bootstrap's hauls/fills stay short.
  compute(room) {
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
        const score = served.reduce((s, o) => s + o.pos.getRangeTo(pos), 0);
        if (score < bestScore) {
          bestScore = score;
          best = pos;
        }
      }
    }
    if (!best) log.warn(`[${room.name}] SpawnPlanner found no clear anchor`);
    return best;
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
