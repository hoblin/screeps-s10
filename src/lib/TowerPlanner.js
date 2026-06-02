import { log } from "./Logger.js";
import { ExtensionPlanner } from "./ExtensionPlanner.js";

// ============================================================================
//  TowerPlanner — picks where Towers go and keeps their construction sites
//  alive as RCL unlocks them (RCL3 = 1 tower, RCL5 = 2, RCL7 = 3, RCL8 = 6).
//
//  Towers want to be CENTRAL — close to both the spawn (the base) and the
//  controller (the upgraders + a likely attack approach). So we spiral out from
//  the MIDPOINT of spawn↔controller and take the nearest buildable tile(s).
//  Tower damage/heal/repair fall off with range (full ≤5, min ≥20), and the
//  base sits inside that radius, so dead-centre placement covers what matters.
//
//  Geometry is pure and deterministic (terrain + spawn/controller positions);
//  occupancy is re-checked at placement time. This mirrors ExtensionPlanner and
//  reuses its primitives (ring / occupied / reservedTiles / key) — same
//  room-planning math, kept in one place rather than copy-pasted.
// ============================================================================

// How far from the central anchor we search for tower tiles. The base is
// compact, so a radius-10 box always holds enough free tiles for the RCL8 cap
// of 6 towers even after walls and reserved tiles are removed.
const MAX_RADIUS = 10;

export const TowerPlanner = {
  // The central anchor towers cluster around: the midpoint of spawn↔controller.
  centerTile(anchorA, anchorB) {
    return {
      x: Math.round((anchorA.x + anchorB.x) / 2),
      y: Math.round((anchorA.y + anchorB.y) / 2),
    };
  },

  // Up to `count` buildable tower tiles spiralling out from `center`, nearest
  // first. Within each ring, tiles matching the spawn's checkerboard colour come
  // first so a tower lands on an extension-colour cell and leaves the walkable
  // lane between extensions intact (extensions skip whatever the tower claims).
  // Pure geometry: depends only on terrain + source/controller anchors, so the
  // result is stable and safe to cache.
  planPositions(room, center, parityAnchor, count) {
    const terrain = room.getTerrain();
    const reserved = ExtensionPlanner.reservedTiles(room);
    const parity = (parityAnchor.x + parityAnchor.y) % 2;
    const positions = [];

    const buildable = (x, y) =>
      // Leave a 1-tile buffer off the room edge (structures stop at 1..48).
      x >= 2 &&
      x <= 47 &&
      y >= 2 &&
      y <= 47 &&
      terrain.get(x, y) !== TERRAIN_MASK_WALL &&
      !reserved.has(ExtensionPlanner.key(x, y));

    for (let r = 0; r <= MAX_RADIUS && positions.length < count; r++) {
      const tiles = r === 0 ? [center] : ExtensionPlanner.ring(center, r);
      const onColour = tiles.filter((t) => (t.x + t.y) % 2 === parity);
      const offColour = tiles.filter((t) => (t.x + t.y) % 2 !== parity);
      for (const { x, y } of [...onColour, ...offColour]) {
        if (positions.length >= count) break;
        if (!buildable(x, y)) continue;
        positions.push(new RoomPosition(x, y, room.name));
      }
    }
    return positions;
  },

  countTowers(room, find) {
    return room.find(find, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }).length;
  },

  // Keep tower construction sites alive on the planned tiles, up to the current
  // RCL cap. Idempotent: only fills the gap between what RCL allows and what
  // already exists (built + queued), so it's safe to call every tick. Non-OK
  // createConstructionSite results (global 100-site cap, RCL gating) are logged,
  // never thrown.
  ensureSites(room, positions, rclCap) {
    const built = this.countTowers(room, FIND_MY_STRUCTURES);
    const queued = this.countTowers(room, FIND_MY_CONSTRUCTION_SITES);
    const slots = rclCap - built - queued;
    if (slots <= 0) return;

    let placed = 0;
    let capHit = false;
    for (const pos of positions) {
      if (placed >= slots) break;
      if (ExtensionPlanner.occupied(pos)) continue;

      const result = room.createConstructionSite(pos, STRUCTURE_TOWER);
      if (result === OK) {
        placed++;
      } else if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        // Global construction-site cap or RCL cap — no point trying more tiles.
        log.warn(`[${room.name}] tower site failed: ${result}`);
        capHit = true;
        break;
      } else if (result !== ERR_INVALID_TARGET) {
        // ERR_INVALID_TARGET = a tile we couldn't detect as occupied; skip it
        // quietly. Anything else is worth surfacing.
        log.warn(`[${room.name}] tower site at ${pos} failed: ${result}`);
      }
    }

    // Surface a genuine shortfall (no silent caps): RCL allows more towers than
    // the room geometry could fit near the base centre.
    if (!capHit && placed < slots) {
      log.warn(
        `[${room.name}] TowerPlanner: room fits ${built + queued + placed} ` +
          `towers near base centre but RCL allows ${rclCap}`
      );
    }
  },
};
