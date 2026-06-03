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
    // coordKey -> boolean: is this tile blocked by an obstacle structure? Filled
    // lazily during resolve and reused, so a tile checked by many overlapping
    // shove-chains costs one lookForAt. Safe to memoize for the manager's whole
    // life because it's tick-scoped (one manager per room per tick, structures
    // don't move mid-tick).
    this.obstacleCache = new Map();
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
    // claims its tile first and gets to shove the rest. Equal priorities break
    // by creep name — a stable, tick-to-tick-deterministic tiebreak (Map
    // iteration order isn't), so same-priority creeps don't jitter.
    const movers = [...this.intents.values()]
      .filter((intent) => intent.creep.my && intent.creep.fatigue === 0)
      .sort((a, b) => a.priority - b.priority || (a.creep.name < b.creep.name ? -1 : 1))
      .map((intent) => intent.creep);

    for (const creep of movers) {
      if (assignedDest.has(creep.name)) continue;
      // `stack` = creeps on the active recursion path (for cycle detection);
      // `failed` = creeps proven immovable, memoized to bound THIS search to
      // O(creeps). Both are per-mover: whether a creep can move via a rotation
      // depends on this mover's stack, so a creep that fails for one mover may
      // still move for another — sharing `failed` would wrongly deny that. Per
      // mover keeps each search complete; total work stays O(creeps²).
      this.findRoute(
        creep,
        {
          terrain,
          occupantByPos,
          movementMap,
          assignedDest,
          assign,
          stack: new Set(),
          failed: new Set(),
        },
        true // root mover: advance on its own intent or stay put (no sidestep)
      );
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
  // way. Returns true if a placement (a shove-chain or a swap) was found.
  //
  // Two sets do the bookkeeping, and the distinction is what makes cycle
  // detection correct AND keeps the search bounded:
  //   - ctx.stack  = creeps on the CURRENT recursion path (added on enter,
  //     removed on exit). A candidate occupied by a creep in `stack` is a true
  //     cycle — that creep is an ancestor and WILL vacate as the chain unwinds.
  //   - ctx.failed = creeps already proven immovable in THIS mover's search. We
  //     never recurse into them again, and — crucially — they are NOT cycle
  //     targets (a creep from a dead sibling branch is not part of the active
  //     chain, so claiming its tile would strand it). This caps one search at
  //     O(creeps); per-mover sets keep it correct (see the resolve loop).
  // `root` = this is a mover advancing on its OWN intent (not a creep being
  // pushed out of someone's way). A root mover may only take its wanted tile or
  // stay put — see candidateTiles.
  findRoute(creep, ctx, root = false) {
    if (ctx.failed.has(creep.name)) return false;
    ctx.stack.add(creep.name);
    const placed = this.searchCandidates(creep, ctx, root);
    ctx.stack.delete(creep.name);
    if (!placed) ctx.failed.add(creep.name);
    return placed;
  }

  // Try each candidate tile in preference order; assign the first that works.
  searchCandidates(creep, ctx, root) {
    for (const pos of this.candidateTiles(creep, ctx, root)) {
      const key = coordKey(pos.x, pos.y);
      if (ctx.movementMap.has(key)) continue; // tile already claimed this resolve

      const occupant = ctx.occupantByPos.get(key);
      if (!occupant || occupant.name === creep.name) {
        ctx.assign(creep, pos);
        return true;
      }
      // The occupant has already been assigned a move (assignedDest), so it's
      // vacating this tile — we can take it. It can't be staying here: a creep is
      // never assigned to its own tile, so assignedDest always points elsewhere.
      if (ctx.assignedDest.has(occupant.name)) {
        ctx.assign(creep, pos);
        return true;
      }
      // True cycle: occupant is an ancestor on the current recursion path, so it
      // vacates as the chain unwinds. No recursion ran since the movementMap.has
      // check above, so the tile is still free to claim.
      if (ctx.stack.has(occupant.name)) {
        ctx.assign(creep, pos);
        return true;
      }
      if (ctx.failed.has(occupant.name)) continue; // known immovable this tick
      // Otherwise try to shove the occupant out of the way, then take its tile.
      // The shove recursion may itself claim THIS tile (a creep deeper in the
      // chain can cycle back onto it), so re-check it's still free before taking
      // it — else we'd overwrite that creep's assignment and strand it.
      if (this.findRoute(occupant, ctx) && !ctx.movementMap.has(key)) {
        ctx.assign(creep, pos);
        return true;
      }
    }
    return false;
  }

  // Tiles `creep` is willing to occupy, in preference order. Every creep prefers
  // its requested next tile (`wanted`). An anchored creep offers nothing — it
  // cannot be shoved.
  //
  // The neighbour tiles are offered ONLY when the creep is being PUSHED out of a
  // higher-priority creep's way (root === false). A ROOT mover — one advancing on
  // its own intent — must NOT sidestep to a neighbour: if it can't get `wanted`
  // (push chain failed), it stays put and lets the stuck-counter in travelTo
  // re-route it. Sidestepping is exactly the blocked-creep "dance" (#64): the
  // creep shuffles to a neighbour, ends up off its path, repaths, and bounces
  // back next tick.
  candidateTiles(creep, ctx, root) {
    if (this.isAnchored(creep)) return [];

    const tiles = [];
    const intent = this.intents.get(creep.name);
    const wanted = intent && creep.fatigue === 0 ? intent.target : null;
    // Same exit-tile guard as walkableNeighbours: never step onto a room edge
    // (it would change rooms). `wanted` comes from a maxRooms:1 path so this is
    // belt-and-braces, but it keeps the invariant symmetric and explicit.
    if (wanted && this.isInteriorTile(wanted.x, wanted.y)) tiles.push(wanted);

    if (root) return tiles; // advance or stay — no sidestep

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
    const key = coordKey(x, y);
    const cached = this.obstacleCache.get(key);
    if (cached !== undefined) return cached;

    let blocked = false;
    for (const structure of this.room.lookForAt(LOOK_STRUCTURES, x, y)) {
      if (OBSTACLE_OBJECT_TYPES.includes(structure.structureType)) {
        blocked = true;
        break;
      }
      // A rampart we don't own blocks us; our own ramparts are walkable.
      if (structure.structureType === STRUCTURE_RAMPART && !structure.my) {
        blocked = true;
        break;
      }
    }
    this.obstacleCache.set(key, blocked);
    return blocked;
  }
}
