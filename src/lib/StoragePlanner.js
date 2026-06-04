import { ExtensionPlanner } from "./ExtensionPlanner.js";
import { TowerPlanner } from "./TowerPlanner.js";
import { log } from "./Logger.js";

// ============================================================================
//  StoragePlanner — places the single Storage unlocked at RCL4 (#16).
//
//  Storage is the central energy buffer, the Stage-3 pivot (STRATEGY.md: "the
//  heart of mid-game logistics"). It's ONE structure, wanted CENTRAL — a short hop
//  for the whole hauler fleet — so we spiral out from the spawn↔controller midpoint
//  (same anchor as towers) and take the first buildable tile on the spawn's
//  checkerboard colour, so storage never sits on the walkable lane and always has
//  adjacent free tiles for haulers/upgraders to stand on.
//
//  Pure geometry only; the Hatchery owns the lifecycle (cache + ensureSite + RCL
//  gate), exactly as it owns extensions and DefenseOverlord owns towers. Reuses
//  ExtensionPlanner's spiral/occupied/reserved primitives + TowerPlanner's midpoint
//  (mirror, don't copy-paste — CLAUDE.md).
// ============================================================================

// How far out from the base midpoint to look for a central buildable tile. The
// base interior is small; 10 rings cover it comfortably.
const MAX_RADIUS = 10;

export const StoragePlanner = {
  // The central tile for storage: spiral from the spawn↔controller midpoint and take
  // the first buildable, non-reserved tile on the spawn's checkerboard colour.
  // Returns a RoomPosition, or null if nothing central is buildable. Pure + stable
  // (terrain + anchors only), so the caller caches it.
  planPosition(room, spawnPos, controllerPos) {
    const center = TowerPlanner.centerTile(spawnPos, controllerPos);
    const parity = (spawnPos.x + spawnPos.y) % 2; // share the spawn's colour → walkable neighbours
    const reserved = ExtensionPlanner.reservedTiles(room);
    // Never take a tile the tower layout needs: TowerPlanner plans EXACTLY the RCL8
    // tower cap with no headroom (unlike extensions, which over-allocate), so a tile
    // stolen from it = a tower we can never place. Exclude the deterministic tower
    // tiles (same midpoint + parity as us). Computed here, not read from Memory, so
    // it holds even before DefenseOverlord has cached them.
    const towerTiles = new Set(
      TowerPlanner.planPositions(
        room,
        center,
        spawnPos,
        (CONTROLLER_STRUCTURES[STRUCTURE_TOWER] || {})[8] || 0
      ).map((p) => ExtensionPlanner.key(p.x, p.y))
    );
    const terrain = room.getTerrain();

    for (let r = 0; r <= MAX_RADIUS; r++) {
      for (const { x, y } of ExtensionPlanner.ring(center, r)) {
        if (x < 2 || x > 47 || y < 2 || y > 47) continue; // keep a walkable lane off the edge
        if ((x + y) % 2 !== parity) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const tileKey = ExtensionPlanner.key(x, y);
        if (reserved.has(tileKey) || towerTiles.has(tileKey)) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (!ExtensionPlanner.occupied(pos)) return pos;
      }
    }
    return null;
  },

  // Keep the storage construction site alive (create-or-skip), cap-1. Storage is a
  // single structure, so skip if one is built OR already under construction ANYWHERE
  // in the room — not just on the planned tile. A site elsewhere (a cached-position
  // mismatch, a manual placement) would otherwise make createConstructionSite fail
  // and log-spam every tick. Log a non-OK result, never throw.
  ensureSite(room, position) {
    if (room.storage) return; // already built
    const inProgress = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_STORAGE,
    });
    if (inProgress.length > 0) return;

    const result = room.createConstructionSite(position, STRUCTURE_STORAGE);
    if (result !== OK) {
      log.warn(`[${room.name}] storage site at ${position} failed: ${result}`);
    }
  },
};
