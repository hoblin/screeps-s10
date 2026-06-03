// ============================================================================
//  TrafficManager — priority-based creep movement resolution (issue #55).
//
//  Problem it solves: vanilla `moveTo` treats a standing creep as a hard
//  obstacle — it can only path AROUND it, never ask it to move. So a full hauler
//  can be permanently walled in by idle workers ringing the tile it must reach,
//  and the whole colony stalls (observed live on W55S43).
//
//  How it works — two phases per tick:
//    1. DECIDE  (during role logic): `creep.travelTo(target)` no longer moves the
//       creep. It computes the desired NEXT tile (one path step) and REGISTERS a
//       movement intent here. Mirrors the spawn pipeline: overlords request, the
//       Hatchery commits — here roles request a step, the resolver commits moves.
//    2. RESOLVE (once, after every colony has run — see Kernel.tick): walk the
//       intents in priority order and assign final tiles, SHOVING lower-priority
//       / idle creeps out of a higher-priority creep's way (and swapping creeps
//       that want to trade tiles). Then issue the actual `creep.move` calls.
//
//  Each intent carries a priority (lower number wins, same convention as spawn
//  priority). The resolver is a pure mechanism — it doesn't know about roles; the
//  caller (Creep.travelTo) supplies the priority, defaulted from the creep's Role
//  and overridable per-call so a future Behavior (#39) can re-rank a single creep.
//  Miners on their post and tired creeps are "anchored" — never shoved. Foreign
//  creeps we can't command are anchored too (pure obstacles).
//
//  State is tick-scoped: a per-room manager is created on first intent and
//  discarded after resolve. Nothing is written to Memory (intents are ephemeral;
//  persisting them would be wasteful and would leak into the next tick).
// ============================================================================

// Per-tick registry of room managers. Auto-reset when the tick advances so a
// stale manager never resolves intents from a previous tick.
const _managers = new Map(); // roomName -> TrafficManager
let _registryTick = -1;

function syncRegistryToTick() {
  if (_registryTick !== Game.time) {
    _registryTick = Game.time;
    _managers.clear();
  }
}

// Pack a tile's (x, y) into a unique integer key. Screeps rooms are 50×50 with
// coords 0–49, so x*50+y is collision-free.
const coordKey = (x, y) => x * 50 + y;

export class TrafficManager {
  constructor(room) {
    this.room = room;
    this.intents = new Map(); // creepName -> { creep, target: RoomPosition, priority }
  }

  // Get (or lazily create) the manager for a room, scoped to the current tick.
  static for(room) {
    syncRegistryToTick();
    let manager = _managers.get(room.name);
    if (!manager) {
      manager = new TrafficManager(room);
      _managers.set(room.name, manager);
    }
    return manager;
  }

  // Resolve every room that collected intents this tick, then clear the registry.
  // Called once from Kernel.tick after all colonies have run. `lowBucket` is
  // accepted for symmetry with the rest of the pipeline, but movement always
  // runs: creeps registered intents instead of moving, so skipping resolve would
  // freeze the colony. The resolver is O(creeps) and cheap.
  static resolveAll(_lowBucket) {
    syncRegistryToTick();
    for (const manager of _managers.values()) {
      manager.resolve();
    }
    _managers.clear();
  }

  // Record a creep's desired next tile (one path step toward its target) and the
  // priority it moves at (lower = wins a contested tile).
  register(creep, nextPos, priority) {
    this.intents.set(creep.name, { creep, target: nextPos, priority });
  }

  // ---- resolution ----------------------------------------------------------

  resolve() {
    const terrain = this.room.getTerrain();

    // Snapshot every creep's CURRENT tile — the resolver reasons about original
    // positions and only commits the deltas at the end.
    const occupantByPos = new Map(); // coordKey -> creep
    for (const creep of this.room.find(FIND_CREEPS)) {
      occupantByPos.set(coordKey(creep.pos.x, creep.pos.y), creep);
    }

    // movementMap: destination coordKey -> { creep, pos } (the winner of a tile)
    // assignedDest: creepName -> destination coordKey (inverse, for quick lookup)
    const movementMap = new Map();
    const assignedDest = new Map();

    const assign = (creep, pos) => {
      const key = coordKey(pos.x, pos.y);
      movementMap.set(key, { creep, pos });
      assignedDest.set(creep.name, key);
    };

    // Movers = our creeps that asked to move and physically can this tick.
    // Sorted by the intent's priority (lower wins) so the most important creep
    // claims its tile first and gets to shove the rest.
    const movers = [...this.intents.values()]
      .filter((intent) => intent.creep.my && intent.creep.fatigue === 0)
      .sort((a, b) => a.priority - b.priority)
      .map((intent) => intent.creep);

    for (const creep of movers) {
      if (assignedDest.has(creep.name)) continue;
      this.findRoute(creep, new Set([creep.name]), {
        terrain,
        occupantByPos,
        movementMap,
        assignedDest,
        assign,
      });
    }

    // Commit: move each creep that ended up assigned a tile other than its own.
    for (const { creep, pos } of movementMap.values()) {
      if (!creep.pos.isEqualTo(pos)) {
        creep.move(creep.pos.getDirectionTo(pos));
      }
    }
  }

  // Depth-first augmenting search: try to place `creep` on one of its candidate
  // tiles, recursively relocating whatever lower-priority/idle creep is in the
  // way. Returns true if a placement (possibly a whole shove-chain or a swap)
  // was found. Cycles (A wants B's tile while B wants A's) resolve as a rotation
  // — everyone in the chain vacates together.
  findRoute(creep, visited, ctx) {
    for (const pos of this.candidateTiles(creep, ctx)) {
      const key = coordKey(pos.x, pos.y);
      if (ctx.movementMap.has(key)) continue; // tile already claimed this resolve

      const occupant = ctx.occupantByPos.get(key);
      if (!occupant || occupant.name === creep.name) {
        ctx.assign(creep, pos);
        return true;
      }
      // The occupant already decided to move elsewhere → its tile is freeing up.
      // (If it were staying put, movementMap.has(key) above would be true.)
      if (ctx.assignedDest.has(occupant.name)) {
        ctx.assign(creep, pos);
        return true;
      }
      // Cycle closure: occupant is already in this shove-chain — we reached it by
      // recursing through it earlier, so it WILL vacate this tile as the chain
      // unwinds (a rotation). No recursion ran since the movementMap.has(key)
      // check above, so the tile is still free to claim.
      if (visited.has(occupant.name)) {
        ctx.assign(creep, pos);
        return true;
      }
      // Otherwise try to shove the occupant out of the way, then take its tile.
      // The shove recursion may itself claim THIS tile (a creep deeper in the
      // chain can cycle back onto it), so re-check it's still free before taking
      // it — else we'd overwrite that creep's assignment and strand it.
      visited.add(occupant.name);
      if (this.findRoute(occupant, visited, ctx) && !ctx.movementMap.has(key)) {
        ctx.assign(creep, pos);
        return true;
      }
    }
    return false;
  }

  // Tiles `creep` is willing to occupy, in preference order. A mover prefers its
  // requested next tile, then any walkable neighbour (so it can still be nudged
  // aside if something more important needs that exact tile). An anchored creep
  // offers nothing — it cannot be shoved.
  candidateTiles(creep, ctx) {
    if (this.isAnchored(creep)) return [];

    const tiles = [];
    const intent = this.intents.get(creep.name);
    const wanted = intent && creep.fatigue === 0 ? intent.target : null;
    // Same exit-tile guard as walkableNeighbours: never step onto a room edge
    // (it would change rooms). `wanted` comes from a maxRooms:1 path so this is
    // belt-and-braces, but it keeps the invariant symmetric and explicit.
    if (wanted && this.isInteriorTile(wanted.x, wanted.y)) tiles.push(wanted);

    for (const pos of this.walkableNeighbours(creep.pos, ctx.terrain)) {
      if (wanted && pos.x === wanted.x && pos.y === wanted.y) continue;
      tiles.push(pos);
    }
    return tiles;
  }

  // A creep that must never be pushed: foreign creeps (we can't command them),
  // creeps still spawning or tired (can't move this tick anyway), and a static
  // miner parked on its assigned post (its tile is its job). A miner still
  // walking to its post is NOT anchored — it can be nudged like anyone else.
  isAnchored(creep) {
    if (!creep.my || creep.spawning || creep.fatigue > 0) return true;
    if (creep.memory.role === "miner") {
      const post = creep.memory.miningPos;
      if (post && creep.pos.x === post.x && creep.pos.y === post.y) return true;
    }
    return false;
  }

  // The 8 neighbouring tiles that are physically enterable: in the interior (we
  // never shove a creep onto an exit tile — that would change rooms), not a wall,
  // and not blocked by an obstacle structure.
  walkableNeighbours(pos, terrain) {
    const neighbours = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = pos.x + dx;
        const y = pos.y + dy;
        if (!this.isInteriorTile(x, y)) continue; // keep off room-edge exit tiles
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (this.hasObstacleStructure(x, y)) continue;
        neighbours.push(new RoomPosition(x, y, this.room.name));
      }
    }
    return neighbours;
  }

  // Room coords run 0–49; the 0 and 49 rows/columns are exit tiles — stepping
  // onto one moves the creep to the adjacent room, so we never target them.
  isInteriorTile(x, y) {
    return x > 0 && x < 49 && y > 0 && y < 49;
  }

  hasObstacleStructure(x, y) {
    for (const structure of this.room.lookForAt(LOOK_STRUCTURES, x, y)) {
      if (OBSTACLE_OBJECT_TYPES.includes(structure.structureType)) return true;
      // A rampart we don't own blocks us; our own ramparts are walkable.
      if (structure.structureType === STRUCTURE_RAMPART && !structure.my) return true;
    }
    return false;
  }
}
