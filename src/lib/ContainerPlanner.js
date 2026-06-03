import { log } from "./Logger.js";

// ============================================================================
//  ContainerPlanner — shared geometry for placing a container near an anchor and
//  keeping its construction site alive. Two callers, two geometries:
//
//    • SOURCE container (MiningOverlord): a static miner must STAND on it, so it
//      hugs the source. `bestContainerTile` picks the source-adjacent tile
//      closest BY PATH to a spawn — shortest hauler trip.
//    • CONTROLLER container (UpgradeOverlord): upgraders only need range 3, and
//      the hauler that fills it shouldn't push into the upgrader cluster to
//      deliver. `controllerContainerTile` places it TWO tiles short of the
//      controller, on the source->controller approach — drop-off at the edge of
//      the work zone, not its centre.
//
//  Both return { position, reachedByPath }: reachedByPath is false when pathing
//  didn't resolve, so the caller knows not to cache a transient failure. Keeping
//  both geometries here means the planners can't drift apart and the pure
//  geometry is trivial to reason about in one place.
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

  // The controller container, unlike a source container, is NOT glued to its
  // anchor. A static miner stands ON its container, so that one must hug the
  // source. But upgraders work at range 3, and the hauler filling the controller
  // container shouldn't have to push into the upgrader cluster to deliver. So we
  // place this container TWO tiles short of the controller along the real
  // source->controller approach: the hauler drops off at the edge of the work
  // zone, upgraders stand past it toward the controller (still within
  // `upgradeController` range 3), and the supply lane stays clear.
  //
  // Walk the `anchorPos`->`controllerPos` path backward from the controller and
  // take the first buildable tile at chebyshev distance 2..3 from it. Returns the
  // same { position, reachedByPath } contract as `bestContainerTile`, so the
  // caller never caches a transient pathing failure as the permanent answer.
  controllerContainerTile(room, controllerPos, anchorPos) {
    const path = anchorPos.findPathTo(controllerPos, { ignoreCreeps: true });
    if (path.length === 0) return { position: null, reachedByPath: false };

    const terrain = room.getTerrain();
    for (let i = path.length - 1; i >= 0; i--) {
      const { x, y } = path[i];
      const dist = Math.max(
        Math.abs(x - controllerPos.x),
        Math.abs(y - controllerPos.y)
      );
      // Two cells short of the controller — far enough off the dist-1 corner to
      // clear the cluster, near enough to keep upgraders in range 3.
      if (dist < 2 || dist > 3) continue;
      if (this.isBuildableTile(room, terrain, x, y)) {
        return {
          position: new RoomPosition(x, y, room.name),
          reachedByPath: true,
        };
      }
    }
    // The whole approach was too short or blocked — don't cache a guess; the
    // caller retries next tick once the geometry resolves.
    return { position: null, reachedByPath: false };
  },

  // A tile we can drop a container on: inside the buildable interior (1..48),
  // not a wall, and not already occupied by a blocking structure. Path tiles
  // already route around spawns/sources, but a road may share the tile (legal)
  // so we only reject structures that truly can't coexist with a container.
  isBuildableTile(room, terrain, x, y) {
    if (x < 1 || x > 48 || y < 1 || y > 48) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
    const blocked = room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .some(
        (s) =>
          s.structureType !== STRUCTURE_ROAD &&
          s.structureType !== STRUCTURE_RAMPART
      );
    return !blocked;
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
