import { log } from "./Logger.js";

// ============================================================================
//  ContainerPlanner — shared geometry for parking a creep on (or beside) a
//  container that hugs an anchor: a source for static miners, the controller for
//  upgraders. Both cases need the SAME three steps:
//
//    1. find the non-wall tiles around the anchor,
//    2. pick the one closest BY PATH to a logistics origin (a spawn, or a source
//       container) so the creep/hauler trip is as short as possible,
//    3. keep a container construction site alive on that tile until it's built.
//
//  MiningOverlord grew this logic first; the controller container needs the exact
//  same thing. Keeping it here means the two planners can't drift apart, and the
//  pure geometry is trivial to reason about in one place.
// ============================================================================
export const ContainerPlanner = {
  // The 8 tiles around `position` that aren't walls, clamped to the buildable
  // room interior (1..48 — the outer edge can't hold structures).
  walkableTilesAround(room, position) {
    const terrain = room.getTerrain();
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = position.x + dx;
        const y = position.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        tiles.push(new RoomPosition(x, y, position.roomName));
      }
    }
    return tiles;
  },

  // Of the walkable tiles around `target`, the one closest BY PATH to `anchorPos`
  // — that minimises the trip between the container and whatever supplies it.
  // Returns { position, reachedByPath }: reachedByPath is false when nothing was
  // pathable and we fell back to the first walkable tile, so the caller knows not
  // to cache a transient pathing failure as if it were the real answer.
  bestContainerTile(room, target, anchorPos) {
    const walkable = this.walkableTilesAround(room, target);
    if (walkable.length === 0) return { position: null, reachedByPath: false };

    let best = null;
    let bestLength = Infinity;
    for (const tile of walkable) {
      const path = anchorPos.findPathTo(tile, { ignoreCreeps: true });
      // Unreachable tiles return a path that doesn't end at the tile.
      const reaches =
        path.length > 0 &&
        path[path.length - 1].x === tile.x &&
        path[path.length - 1].y === tile.y;
      const length = reaches ? path.length : Infinity;
      if (length < bestLength) {
        bestLength = length;
        best = tile;
      }
    }

    if (best) return { position: best, reachedByPath: true };
    // Nothing was pathable: let a creep still stand somewhere, but flag it so the
    // caller doesn't cache this guess as the permanent answer.
    return { position: walkable[0], reachedByPath: false };
  },

  // Keep a container construction site alive on `position` until it's built.
  // No-op once a container or its site already exists there, so it's safe to call
  // every tick. Non-OK createConstructionSite results (the 5-container/room or
  // 100-site global caps, RCL gating) are logged, never thrown — a missing
  // container should be debuggable, not fatal. `label` tags the log line so
  // source vs controller failures are distinguishable.
  ensureSite(room, position, label) {
    const here = position.look();
    const hasContainer = here.some(
      (item) =>
        item.type === LOOK_STRUCTURES &&
        item.structure.structureType === STRUCTURE_CONTAINER
    );
    const hasSite = here.some(
      (item) =>
        item.type === LOOK_CONSTRUCTION_SITES &&
        item.constructionSite.structureType === STRUCTURE_CONTAINER
    );
    if (hasContainer || hasSite) return;

    const result = room.createConstructionSite(position, STRUCTURE_CONTAINER);
    if (result !== OK) {
      log.warn(
        `[${room.name}] ${label} container site at ${position} failed: ${result}`
      );
    }
  },
};
