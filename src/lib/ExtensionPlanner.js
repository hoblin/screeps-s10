import { log } from "./Logger.js";

// ============================================================================
//  ExtensionPlanner — picks where Extensions go and keeps their construction
//  sites alive, so spawn energy capacity grows as RCL unlocks more of them
//  (RCL2 = 5 extensions = 300→550 capacity, RCL3 = 10, …, RCL8 = 60).
//
//  Layout = a checkerboard around the spawn. Extensions occupy one colour of the
//  board, so the other colour stays a connected walkable lattice: no two
//  extensions are ever orthogonally adjacent, a creep steps diagonally between
//  the free tiles, and every extension is reachable (and fillable) from range 1.
//  Tiles touching a source or the controller are reserved — we never block a
//  mining position or the controller container. Candidates are emitted nearest
//  the spawn first, so extensions cluster tight and fill trips stay short.
//
//  Geometry is pure and deterministic (terrain only); occupancy is re-checked at
//  placement time. This mirrors ContainerPlanner: shared geometry in one place,
//  the owning HiveCluster/Overlord handles caching + lifecycle.
// ============================================================================

// How far from the spawn we search for extension tiles. A radius-8 box holds
// ~144 tiles of one checkerboard colour — comfortably more than the RCL8 cap of
// 60, even after walls and reserved tiles are removed.
const MAX_RADIUS = 8;

export const ExtensionPlanner = {
  key(x, y) {
    return `${x},${y}`;
  },

  // Tiles we must NOT build extensions on: the source/controller anchors and the
  // ring of tiles hugging them (where mining positions and the controller
  // container live), plus the mineral tile (future extractor). Returned as a Set
  // of "x,y" keys for O(1) lookup during the spiral.
  reservedTiles(room) {
    const reserved = new Set();
    const addArea = (pos, range) => {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          reserved.add(this.key(pos.x + dx, pos.y + dy));
        }
      }
    };
    for (const source of room.find(FIND_SOURCES)) addArea(source.pos, 1);
    if (room.controller) addArea(room.controller.pos, 1);
    const mineral = room.find(FIND_MINERALS)[0];
    if (mineral) addArea(mineral.pos, 0);
    return reserved;
  },

  // The tiles at Chebyshev distance exactly `r` from `center` (the square ring).
  ring(center, r) {
    const tiles = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        tiles.push({ x: center.x + dx, y: center.y + dy });
      }
    }
    return tiles;
  },

  // Up to `count` extension tiles around `anchor`, nearest first. Pure geometry:
  // depends only on terrain + source/controller positions, so the result is
  // stable and safe to cache.
  planPositions(room, anchor, count) {
    const terrain = room.getTerrain();
    const parity = (anchor.x + anchor.y) % 2; // extensions share the spawn's colour
    const reserved = this.reservedTiles(room);
    const positions = [];

    for (let r = 1; r <= MAX_RADIUS && positions.length < count; r++) {
      for (const { x, y } of this.ring(anchor, r)) {
        if (positions.length >= count) break;
        // Leave a 1-tile buffer off the room edge (structures stop at 1..48; the
        // buffer keeps a walkable lane around the extension field).
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
        if ((x + y) % 2 !== parity) continue; // wrong checkerboard colour
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (x === anchor.x && y === anchor.y) continue; // the spawn itself
        if (reserved.has(this.key(x, y))) continue;
        positions.push(new RoomPosition(x, y, room.name));
      }
    }
    return positions;
  },

  // True if `pos` already holds something that would block an extension. In
  // Screeps a rampart is the ONLY structure an extension can share a tile with;
  // everything else — including a road — blocks it. (An extension can't sit on a
  // road: createConstructionSite returns ERR_INVALID_TARGET, which would silently
  // cost us a slot and could trip a false "geometry shortfall" warning once roads
  // land on hot paths in #14.) Any construction site also blocks.
  occupied(pos) {
    return pos.look().some(
      (item) =>
        (item.type === LOOK_STRUCTURES &&
          item.structure.structureType !== STRUCTURE_RAMPART) ||
        item.type === LOOK_CONSTRUCTION_SITES
    );
  },

  countExtensions(room, find) {
    return room.find(find, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;
  },

  // Keep extension construction sites alive on the planned tiles, up to the
  // current RCL cap. Idempotent: only fills the gap between what RCL allows and
  // what already exists (built + already-queued sites), so it's safe to call
  // every tick. Non-OK createConstructionSite results (global 100-site cap, RCL
  // gating) are logged, never thrown.
  ensureSites(room, positions, rclCap) {
    const built = this.countExtensions(room, FIND_MY_STRUCTURES);
    const queued = this.countExtensions(room, FIND_MY_CONSTRUCTION_SITES);
    const slots = rclCap - built - queued;
    if (slots <= 0) return;

    let placed = 0;
    let capHit = false;
    for (const pos of positions) {
      if (placed >= slots) break;
      if (this.occupied(pos)) continue;

      const result = room.createConstructionSite(pos, STRUCTURE_EXTENSION);
      if (result === OK) {
        placed++;
      } else if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        // Global construction-site cap or RCL cap — no point trying more tiles.
        log.warn(`[${room.name}] extension site failed: ${result}`);
        capHit = true;
        break;
      } else if (result !== ERR_INVALID_TARGET) {
        // ERR_INVALID_TARGET = a tile we couldn't detect as occupied; skip it
        // quietly. Anything else is worth surfacing.
        log.warn(`[${room.name}] extension site at ${pos} failed: ${result}`);
      }
    }

    // Surface a genuine shortfall (no silent caps): RCL allows more extensions
    // than the room geometry could fit near the spawn.
    if (!capHit && placed < slots) {
      log.warn(
        `[${room.name}] ExtensionPlanner: room fits ${built + queued + placed} ` +
          `extensions near spawn but RCL allows ${rclCap}`
      );
    }
  },
};
