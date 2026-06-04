import { ExtensionPlanner } from "./ExtensionPlanner.js";
import { log } from "./Logger.js";

// ============================================================================
//  LinkPlanner — places a Link adjacent to a hub structure (#17). A Link teleports
//  energy hub→hub for a flat 3% loss + a range-proportional cooldown, no creep
//  involved — so a pair of them kills the longest, most constant internal haul leg.
//
//  Pure geometry only; CommandCenter owns the lifecycle (RCL/affordability gate +
//  ensureSites + cache), exactly as StoragePlanner serves the Hatchery and
//  TowerPlanner serves DefenseOverlord. Reuses ExtensionPlanner's reserved/occupied
//  primitives (mirror, don't copy-paste — CLAUDE.md).
// ============================================================================
export const LinkPlanner = {
  // The link tile for a hub: the open, non-wall neighbour of `anchorPos` closest to
  // `toward` (its partner link's anchor) — proximity minimises the transfer cooldown,
  // which scales with link range. Skips the anchor tile itself, walls, tiles the
  // extension/tower layout reserves, and occupied tiles. Returns a RoomPosition, or
  // null if the hub has no free neighbour. Pure + stable, so the caller caches it.
  linkTile(room, anchorPos, toward) {
    const terrain = room.getTerrain();
    const reserved = ExtensionPlanner.reservedTiles(room);
    let best = null;
    let bestRange = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue; // not the hub tile itself
        const x = anchorPos.x + dx;
        const y = anchorPos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue; // buildable interior only (0/49 are exit/wall tiles)
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (reserved.has(ExtensionPlanner.key(x, y))) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (ExtensionPlanner.occupied(pos)) continue;
        const range = toward ? pos.getRangeTo(toward) : 0;
        if (range < bestRange) {
          best = pos;
          bestRange = range;
        }
      }
    }
    return best;
  },

  // Keep link construction sites alive for the priority `layout` ([{ role, pos }]),
  // up to the current RCL link `cap` (counting built + queued). A link is one
  // structure per tile, so skip a tile that already holds a link or its site. Non-OK
  // results are logged, never thrown; a hard cap (global 100-site limit / RCL gating)
  // breaks the loop so we don't log-spam every tick (mirrors ExtensionPlanner/RoadPlanner).
  ensureSites(room, layout, cap) {
    if (cap <= 0) return;
    const built = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    }).length;
    let queued = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    }).length;

    for (const { pos } of layout) {
      if (built + queued >= cap) return; // at the RCL link cap
      const here =
        pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_LINK) ||
        pos.lookFor(LOOK_CONSTRUCTION_SITES).some((s) => s.structureType === STRUCTURE_LINK);
      if (here) continue; // this hub already has its link / site
      const result = room.createConstructionSite(pos, STRUCTURE_LINK);
      if (result === OK) {
        queued++;
      } else if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        // Global site cap or RCL too low — no further tile can succeed this tick.
        log.warn(`[${room.name}] link site failed: ${result}`);
        break;
      } else if (result !== ERR_INVALID_TARGET) {
        // ERR_INVALID_TARGET = a tile we couldn't detect as unbuildable; skip quietly.
        log.warn(`[${room.name}] link site at ${pos} failed: ${result}`);
      }
    }
  },
};
