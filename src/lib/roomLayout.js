// ============================================================================
//  roomLayout — the PURE spatial core of the unified room planner (#258).
//
//  Given a room's physical structure (terrain + sources + controller + mineral)
//  and a base anchor, it lays out EVERY structure for EVERY RCL, the link/container
//  network, and the road spine into ONE tile assignment — computed once, so two
//  structures can never claim the same tile and a road never lands on a structure
//  (the road-on-tower collision class the 7 independent planners couldn't prevent).
//
//  WHY a pure function (no game globals, no game PathFinder): the layout is pure
//  geometry over a terrain grid, so the SAME core runs in two places — the live
//  `RoomPlanner` (feeds `room.getTerrain()`, caches the result) and the offline
//  `bin/plan-map.mjs` verifier (feeds the SQLite-mirror terrain, renders a PNG).
//  Verifying the REAL algorithm offline, on real season rooms, without deploying.
//
//  Planning routes with a grid Dijkstra (not the game PathFinder) keeps it pure and
//  is correct here: this runs ONCE at founding, not per tick, and we want the
//  static shortest path, not live creep-aware movement.
//
//  Coordinate + terrain convention (matches both callers):
//    • tile (x,y), row-major idx = y*50 + x.
//    • terrain(x,y) -> 0 plain | 1 wall | 2 swamp. The engine's `getTerrain().get`
//      already returns exactly these (TERRAIN_MASK_WALL=1, TERRAIN_MASK_SWAMP=2);
//      the offline grid uses the same codes — so the core needs no game constants.
//    • structure-type keys ("spawn","extension",…) ARE the values of the STRUCTURE_*
//      globals, so the live reader feeds the plan's keys straight to
//      createConstructionSite with no mapping.
// ============================================================================

const SIZE = 50;
const idx = (x, y) => y * SIZE + x;

// A binary min-heap (distance → packed-tile node) for Dijkstra. The naive
// linear-scan PQ is ~O(V²) ≈ millions of ops over a 2500-tile room — fine offline
// but a CPU spike on the live founding tick. The heap keeps each search at
// O(E log V), so the once-per-founding plan stays well inside one tick's budget.
class MinHeap {
  constructor() {
    this.d = []; // distances
    this.n = []; // packed tile nodes (y*50+x)
  }
  get size() {
    return this.d.length;
  }
  push(dist, node) {
    this.d.push(dist);
    this.n.push(node);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop() {
    const dist = this.d[0];
    const node = this.n[0];
    const last = this.d.length - 1;
    if (last > 0) {
      this.d[0] = this.d[last];
      this.n[0] = this.n[last];
    }
    this.d.pop();
    this.n.pop();
    const len = this.d.length;
    let i = 0;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < len && this.d[l] < this.d[m]) m = l;
      if (r < len && this.d[r] < this.d[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return { dist, node };
  }
  swap(a, b) {
    const td = this.d[a];
    this.d[a] = this.d[b];
    this.d[b] = td;
    const tn = this.n[a];
    this.n[a] = this.n[b];
    this.n[b] = tn;
  }
}

// Structure-type keys (= the STRUCTURE_* global values, so no game dependency here).
export const S = {
  SPAWN: "spawn",
  EXTENSION: "extension",
  TOWER: "tower",
  STORAGE: "storage",
  LINK: "link",
  CONTAINER: "container",
  TERMINAL: "terminal",
  EXTRACTOR: "extractor",
  LAB: "lab",
  FACTORY: "factory",
  POWER_SPAWN: "powerSpawn",
  NUKER: "nuker",
  OBSERVER: "observer",
  ROAD: "road",
};

// Structures laid out on the parity checkerboard (the core + extensions), in
// placement PRIORITY order: the most important / most-served sit nearest the
// anchor, the rest spiral outward. Each entry resolves its per-RCL instance
// count from the caps table, so there are no hardcoded counts (#258, CLAUDE.md).
// Containers, links and the extractor are NOT here — they're terrain-forced
// (glued to a source/controller/mineral) and placed before the spiral.
const PARITY_ORDER = [
  S.STORAGE, // logistics heart → closest free parity tile to the anchor
  S.TERMINAL,
  S.SPAWN, // the RCL7/8 additional spawns (slot 0 is the anchor itself, see below)
  S.FACTORY,
  S.POWER_SPAWN,
  S.NUKER,
  S.OBSERVER,
  S.TOWER, // central coverage of the base + the controller approach
  S.LAB, // contiguous-ish cluster (reaction-adjacency refined in #21)
  S.EXTENSION, // fill the remaining parity tiles, up to the RCL8 cap of 60
];

// How far the structure interior stays off the room edge. Structures can't sit on
// the outer ring (0/49); we keep one more tile clear (2..47) so a walkable lane
// always rings the base. Containers/links use the full 1..48 (they hug sources).
const STRUCT_MIN = 2;
const STRUCT_MAX = 47;
const EDGE_MIN = 1;
const EDGE_MAX = 48;

// Openness weight when picking an EXPANSION anchor: a tile's score is summed range
// to the served objects MINUS this × its distance-transform openness, so a roomy
// pocket (fits the core) is preferred over a cramped one equally close to the work.
const OPENNESS_WEIGHT = 3;
// Half-width of the anchor search box around the served-objects centroid.
const ANCHOR_SEARCH_RADIUS = 12;

// ----------------------------------------------------------------------------
//  Public entry: compute the whole layout.
//
//  @param terrain   (x,y) -> 0|1|2
//  @param sources   [{x,y}]
//  @param controller {x,y}
//  @param mineral   {x,y} | null
//  @param anchor    {x,y} | null  — the base spawn. Provided for a HOME room (its
//                   spawn[0] was placed manually); null for an EXPANSION room (no
//                   spawn yet → we pick the anchor from terrain).
//  @param controllerStructures  the CONTROLLER_STRUCTURES caps table (live: the
//                   global; offline: a literal mirror) → per-RCL instance counts.
//
//  @return { anchor:{x,y}, structures:{ [type]: [{x,y,rcl}] }, roads:[{x,y,rcl}] }
// ----------------------------------------------------------------------------
export function computeLayout({ terrain, sources, controller, mineral, anchor, controllerStructures }) {
  const ctx = new Layout(terrain, sources, controller, mineral, controllerStructures);
  ctx.resolveAnchor(anchor);
  ctx.placeTerrainForced(); // containers + extractor + links (glued to sources/controller/mineral)
  ctx.placeParityStructures(); // core + towers + labs + extensions, spiral from the anchor
  ctx.placeRoads(); // swamp-neutral spine + per-structure access lanes
  return ctx.result();
}

// The layout computation, encapsulated so the helpers share one occupied set / one
// terrain without threading state through every call.
class Layout {
  constructor(terrain, sources, controller, mineral, controllerStructures) {
    this.terrain = terrain;
    this.sources = sources || [];
    this.controller = controller;
    this.mineral = mineral || null;
    this.caps = controllerStructures;

    this.anchor = null;
    this.occupied = new Set(); // "x,y" tiles claimed by a structure (roads excluded)
    this.structures = {}; // type -> [{x,y,rcl}]
    this.roadRcl = new Map(); // "x,y" -> min rcl (roads, deduped)
    this.reserved = this.reservedTiles(); // mining/upgrade tiles the spiral must not block
    this.containerByRole = {}; // role -> {x,y}, so links can hug their container
  }

  // ---- terrain primitives --------------------------------------------------
  isWall(x, y) {
    return this.terrain(x, y) === 1;
  }
  isSwamp(x, y) {
    return this.terrain(x, y) === 2;
  }
  key(x, y) {
    return `${x},${y}`;
  }

  // The 8 non-wall neighbours of (x,y) within the buildable interior (1..48).
  walkableNeighbours(x, y) {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < EDGE_MIN || nx > EDGE_MAX || ny < EDGE_MIN || ny > EDGE_MAX) continue;
        if (this.isWall(nx, ny)) continue;
        out.push({ x: nx, y: ny });
      }
    }
    return out;
  }

  // Tiles we must NOT build the parity layout on: the ring hugging each source and
  // the controller (mining positions + the controller container + upgrader parking),
  // and the mineral tile (the extractor). Mirrors the old ExtensionPlanner.reservedTiles.
  reservedTiles() {
    const set = new Set();
    const addArea = (p, range) => {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) set.add(this.key(p.x + dx, p.y + dy));
      }
    };
    for (const s of this.sources) addArea(s, 1);
    if (this.controller) addArea(this.controller, 1);
    if (this.mineral) addArea(this.mineral, 0);
    return set;
  }

  // ---- anchor --------------------------------------------------------------
  // Home rooms hand us the manually-placed spawn; expansion rooms have no spawn
  // yet, so we pick the open tile that best balances "central to what it serves"
  // against "roomy enough to fit the core" (distance-transform openness).
  resolveAnchor(given) {
    if (given) {
      this.anchor = { x: given.x, y: given.y };
    } else {
      this.anchor = this.computeAnchor();
    }
    // The anchor is spawn slot 0 (RCL1). Home rooms already have it built; the
    // reader's idempotent ensureSites just skips the existing spawn.
    this.place(S.SPAWN, this.anchor.x, this.anchor.y, 1);
    this.parity = (this.anchor.x + this.anchor.y) % 2;
  }

  // Distance-transform-aware spawn pick: the clear-3×3 tile near the served
  // centroid that minimises summed range to (sources+controller) while preferring
  // open pockets — so the base core has room to grow (master-bot insight, #258).
  computeAnchor() {
    const served = [...this.sources, this.controller].filter(Boolean);
    const cx = Math.round(served.reduce((s, o) => s + o.x, 0) / served.length);
    const cy = Math.round(served.reduce((s, o) => s + o.y, 0) / served.length);
    const open = this.distanceTransform();
    // Lower is better: close to what it serves, minus an openness bonus (roomy pockets
    // fit the core). A served-crowding tile (≤2 from a source/controller) is excluded.
    const score = (x, y) => {
      if (served.some((o) => Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) <= 2)) return Infinity;
      const range = served.reduce((s, o) => s + Math.max(Math.abs(o.x - x), Math.abs(o.y - y)), 0);
      return range - OPENNESS_WEIGHT * open[idx(x, y)];
    };

    // Primary: a clear-3×3 tile in the box around the served centroid (keeps the base
    // near what it serves). Fallback: any clear-3×3 in the whole interior (a winding
    // room may have none near the centroid). Last resort: the best non-wall interior
    // tile — so the anchor is NEVER an impossible wall/edge tile.
    return (
      this.bestAnchorIn(score, cx - ANCHOR_SEARCH_RADIUS, cx + ANCHOR_SEARCH_RADIUS, cy - ANCHOR_SEARCH_RADIUS, cy + ANCHOR_SEARCH_RADIUS, true) ||
      this.bestAnchorIn(score, STRUCT_MIN, STRUCT_MAX, STRUCT_MIN, STRUCT_MAX, true) ||
      this.bestAnchorIn(score, STRUCT_MIN, STRUCT_MAX, STRUCT_MIN, STRUCT_MAX, false) ||
      { x: cx, y: cy }
    );
  }

  // The lowest-`score` tile in the [x0..x1]×[y0..y1] box (clamped to the buildable
  // interior). `requireClear` demands a clear 3×3 (room for the core); when false any
  // non-wall tile qualifies (the degenerate last-resort pass).
  bestAnchorIn(score, x0, x1, y0, y1, requireClear) {
    let best = null;
    let bestScore = Infinity;
    for (let y = Math.max(STRUCT_MIN, y0); y <= Math.min(STRUCT_MAX, y1); y++) {
      for (let x = Math.max(STRUCT_MIN, x0); x <= Math.min(STRUCT_MAX, x1); x++) {
        if (requireClear ? !this.clear3x3(x, y) : this.isWall(x, y)) continue;
        const s = score(x, y);
        if (s < bestScore) {
          bestScore = s;
          best = { x, y };
        }
      }
    }
    return best;
  }

  clear3x3(x, y) {
    for (let yy = y - 1; yy <= y + 1; yy++) {
      for (let xx = x - 1; xx <= x + 1; xx++) {
        if (this.isWall(xx, yy)) return false;
      }
    }
    return true;
  }

  // Chebyshev distance-transform: each non-wall tile's distance to the nearest wall
  // (or room edge) — a cheap "how much open space surrounds this tile" field. Two
  // passes (top-left then bottom-right), the standard 8-connected DT.
  distanceTransform() {
    const d = new Int16Array(SIZE * SIZE);
    const wallOrEdge = (x, y) => x < 0 || y < 0 || x >= SIZE || y >= SIZE || this.isWall(x, y);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (wallOrEdge(x, y)) {
          d[idx(x, y)] = 0;
        } else {
          const a = y > 0 ? d[idx(x, y - 1)] : 0;
          const b = x > 0 ? d[idx(x - 1, y)] : 0;
          const c = x > 0 && y > 0 ? d[idx(x - 1, y - 1)] : 0;
          const e = x < SIZE - 1 && y > 0 ? d[idx(x + 1, y - 1)] : 0;
          d[idx(x, y)] = 1 + Math.min(a, b, c, e);
        }
      }
    }
    for (let y = SIZE - 1; y >= 0; y--) {
      for (let x = SIZE - 1; x >= 0; x--) {
        if (d[idx(x, y)] === 0) continue;
        const a = y < SIZE - 1 ? d[idx(x, y + 1)] : 0;
        const b = x < SIZE - 1 ? d[idx(x + 1, y)] : 0;
        const c = x < SIZE - 1 && y < SIZE - 1 ? d[idx(x + 1, y + 1)] : 0;
        const e = x > 0 && y < SIZE - 1 ? d[idx(x - 1, y + 1)] : 0;
        d[idx(x, y)] = Math.min(d[idx(x, y)], 1 + Math.min(a, b, c, e));
      }
    }
    return d;
  }

  // ---- terrain-forced structures (containers / extractor / links) ----------
  placeTerrainForced() {
    // Source containers: the source-adjacent tile nearest BY (haul) PATH to the
    // anchor — the static miner parks there, the hauler's trip is shortest. rcl 2
    // (static-mining stage). Keyed role "source<i>" so the link can hug it.
    const haulField = this.dijkstra(this.anchor.x, this.anchor.y, (x, y) => (this.isSwamp(x, y) ? 5 : 1));
    this.sources.forEach((src, i) => {
      const tile = this.nearestNeighbourByField(src, haulField);
      if (tile) this.placeContainer(tile, 2, `source${i}`);
    });

    // Controller container: two tiles short of the controller on the anchor→controller
    // approach (the hauler drops at the edge of the upgrader cluster). rcl 2.
    const ctrlTile = this.controllerContainerTile(haulField);
    if (ctrlTile) this.placeContainer(ctrlTile, 2, "controller");

    // Mineral container + extractor: only earn their keep at RCL6 (extractor unlock).
    if (this.mineral) {
      const tile = this.nearestNeighbourByField(this.mineral, haulField);
      if (tile) this.placeContainer(tile, 6, "mineral");
      // The extractor sits ON the mineral tile (no parity/reserved concern).
      this.place(S.EXTRACTOR, this.mineral.x, this.mineral.y, 6);
    }

    this.placeLinks();
  }

  placeContainer(tile, rcl, role) {
    this.place(S.CONTAINER, tile.x, tile.y, rcl, { role });
    this.containerByRole[role] = tile;
  }

  // The source-adjacent (or mineral-adjacent) walkable tile with the smallest haul
  // distance to the anchor. null when the target is walled in / unreachable.
  nearestNeighbourByField(target, field) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.walkableNeighbours(target.x, target.y)) {
      if (this.occupied.has(this.key(n.x, n.y))) continue;
      const d = field[idx(n.x, n.y)];
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // Walk the anchor→controller shortest path backward and take the first buildable
  // tile at Chebyshev distance 2..3 from the controller — far enough off the
  // controller to clear the upgrader cluster, near enough to stay in upgrade range.
  controllerContainerTile(haulField) {
    const path = this.tracePath(haulField, this.controller.x, this.controller.y);
    for (let i = path.length - 1; i >= 0; i--) {
      const { x, y } = path[i];
      const dist = Math.max(Math.abs(x - this.controller.x), Math.abs(y - this.controller.y));
      if (dist < 2 || dist > 3) continue;
      if (this.buildableTile(x, y)) return { x, y };
    }
    return null;
  }

  buildableTile(x, y) {
    if (x < EDGE_MIN || x > EDGE_MAX || y < EDGE_MIN || y > EDGE_MAX) return false;
    if (this.isWall(x, y)) return false;
    return !this.occupied.has(this.key(x, y));
  }

  // Links hug their hub's container, facing the partner so the transfer cooldown
  // (range-proportional) is minimal. Controller link (receiver) first, then the
  // source links (senders) — the source FARTHEST from the controller first (its
  // haul leg is the longest, so linking it saves the most), then a storage link.
  placeLinks() {
    const linkRcls = this.rclSchedule(S.LINK); // e.g. [5,5,6,7,8,8]
    if (!linkRcls.length) return;
    let li = 0;

    const ctrlContainer = this.containerByRole.controller;
    // Order the source containers far→near from the controller.
    const sourceRoles = Object.keys(this.containerByRole)
      .filter((r) => r.startsWith("source"))
      .sort((a, b) => this.rangeToController(this.containerByRole[b]) - this.rangeToController(this.containerByRole[a]));

    // Controller link: beside the controller container, facing the first (farthest)
    // source container so the pair's transfer cooldown is short.
    if (ctrlContainer && sourceRoles.length && li < linkRcls.length) {
      const toward = this.containerByRole[sourceRoles[0]];
      const tile = this.freeNeighbourToward(ctrlContainer, toward);
      if (tile) this.place(S.LINK, tile.x, tile.y, linkRcls[li++], { role: "controller" });
    }
    // Source links, far→near, each facing the controller link's container.
    for (const role of sourceRoles) {
      if (li >= linkRcls.length) break;
      const tile = this.freeNeighbourToward(this.containerByRole[role], ctrlContainer || this.anchor);
      if (tile) this.place(S.LINK, tile.x, tile.y, linkRcls[li++], { role: "source", source: role });
    }
    // Storage link: beside the (planned) storage tile — placed later in the parity
    // pass, so defer; handled in placeParityStructures once storage has a tile.
    this.remainingLinkRcls = linkRcls.slice(li);
  }

  rangeToController(p) {
    return Math.max(Math.abs(p.x - this.controller.x), Math.abs(p.y - this.controller.y));
  }

  // The free, non-wall neighbour of `hub` closest to `toward` — minimises link range.
  freeNeighbourToward(hub, toward) {
    let best = null;
    let bestRange = Infinity;
    for (const n of this.walkableNeighbours(hub.x, hub.y)) {
      if (this.occupied.has(this.key(n.x, n.y))) continue;
      const range = toward ? Math.max(Math.abs(n.x - toward.x), Math.abs(n.y - toward.y)) : 0;
      if (range < bestRange) {
        bestRange = range;
        best = n;
      }
    }
    return best;
  }

  // ---- parity structures (core + towers + labs + extensions) ---------------
  // One nearest-first spiral of buildable parity tiles, consumed in PARITY_ORDER:
  // storage lands closest to the anchor, extensions fill whatever's left. One
  // occupied set means nothing here can collide with a container/link/road.
  placeParityStructures() {
    const candidates = this.orderedParityTiles();
    let ci = 0;
    const takeFree = () => {
      while (ci < candidates.length) {
        const t = candidates[ci++];
        if (!this.occupied.has(this.key(t.x, t.y))) return t;
      }
      return null;
    };

    for (const type of PARITY_ORDER) {
      const rcls = this.rclSchedule(type);
      // The anchor already occupies spawn slot 0, so the spawn type only places the
      // RCL7/8 additional spawns here (the leading rcl-1 entry is the anchor).
      const toPlace = type === S.SPAWN ? rcls.slice(1) : rcls;
      for (const rcl of toPlace) {
        const tile = takeFree();
        if (!tile) {
          this.shortfall = this.shortfall || [];
          this.shortfall.push(type);
          break;
        }
        this.place(type, tile.x, tile.y, rcl);
      }
    }

    // Storage link (deferred from placeLinks): beside the storage tile now that it
    // has one, facing the controller link / anchor.
    const storage = (this.structures[S.STORAGE] || [])[0];
    if (storage && this.remainingLinkRcls && this.remainingLinkRcls.length) {
      const tile = this.freeNeighbourToward(storage, this.containerByRole.controller || this.anchor);
      if (tile) this.place(S.LINK, tile.x, tile.y, this.remainingLinkRcls[0], { role: "storage" });
    }
  }

  // All buildable parity tiles, nearest the anchor first — the spiral the parity
  // structures consume in priority order. Parity = the anchor's checkerboard colour,
  // so the off-colour stays a connected walkable/road lattice between structures.
  orderedParityTiles() {
    const tiles = [];
    for (let y = STRUCT_MIN; y <= STRUCT_MAX; y++) {
      for (let x = STRUCT_MIN; x <= STRUCT_MAX; x++) {
        if ((x + y) % 2 !== this.parity) continue;
        if (this.isWall(x, y)) continue;
        if (this.reserved.has(this.key(x, y))) continue;
        if (x === this.anchor.x && y === this.anchor.y) continue;
        const d = Math.max(Math.abs(x - this.anchor.x), Math.abs(y - this.anchor.y));
        tiles.push({ x, y, d });
      }
    }
    tiles.sort((a, b) => a.d - b.d);
    return tiles;
  }

  // ---- roads ---------------------------------------------------------------
  // A swamp-NEUTRAL spine (so roads spear straight through swamps rather than
  // detouring around them, #257) from the anchor to every container/controller,
  // plus a one-tile access road touching any structure that isn't road-adjacent —
  // the off-parity lattice the parity layout left open.
  placeRoads() {
    // Road-cost field from the anchor: uniform 1 (swamp == plain), and structure
    // tiles are impassable so the spine routes BETWEEN buildings, never over one.
    const field = this.dijkstra(this.anchor.x, this.anchor.y, (x, y) => (this.occupied.has(this.key(x, y)) ? Infinity : 1));

    const spineTargets = [];
    for (const role in this.containerByRole) spineTargets.push({ p: this.containerByRole[role], rcl: role === "mineral" ? 6 : 2 });
    spineTargets.push({ p: this.controller, rcl: 2 });

    for (const { p, rcl } of spineTargets) {
      const path = this.tracePath(field, p.x, p.y);
      for (const t of path) {
        if (this.occupied.has(this.key(t.x, t.y))) continue; // never road a structure tile
        this.addRoad(t.x, t.y, rcl);
      }
    }

    // Access lanes: every placed structure needs a road on a neighbour so fillers /
    // upgraders / the miner can reach it. Skip containers (a creep stands ON them).
    for (const type in this.structures) {
      if (type === S.CONTAINER || type === S.EXTRACTOR) continue;
      for (const s of this.structures[type]) {
        if (this.hasAdjacentRoad(s.x, s.y)) continue;
        const lane = this.freeLaneTile(s.x, s.y);
        if (lane) this.addRoad(lane.x, lane.y, s.rcl);
      }
    }
  }

  addRoad(x, y, rcl) {
    // The road Dijkstra explores the full 0..49 grid, but structures (roads included)
    // can't sit on the room-edge ring — drop any border tile so the realizer never
    // retries an unbuildable site forever.
    if (x < EDGE_MIN || x > EDGE_MAX || y < EDGE_MIN || y > EDGE_MAX) return;
    const k = this.key(x, y);
    const prev = this.roadRcl.get(k);
    if (prev === undefined || rcl < prev) this.roadRcl.set(k, rcl);
  }

  hasAdjacentRoad(x, y) {
    for (const n of this.walkableNeighbours(x, y)) {
      if (this.roadRcl.has(this.key(n.x, n.y))) return true;
    }
    return false;
  }

  // A free off-parity neighbour to drop an access road on (off-parity = the walk
  // lane; never steal a parity structure tile). Falls back to any free neighbour.
  freeLaneTile(x, y) {
    let fallback = null;
    for (const n of this.walkableNeighbours(x, y)) {
      const k = this.key(n.x, n.y);
      if (this.occupied.has(k)) continue;
      if ((n.x + n.y) % 2 !== this.parity) return n; // the walk-lane colour
      fallback = fallback || n;
    }
    return fallback;
  }

  // ---- shared helpers ------------------------------------------------------
  place(type, x, y, rcl, extra) {
    this.occupied.add(this.key(x, y));
    (this.structures[type] ||= []).push({ x, y, rcl, ...(extra || {}) });
  }

  // Per-RCL instance list for a structure type, derived from the caps table: when
  // the cap jumps from caps[r-1] to caps[r], that many instances enter at RCL r.
  // So no counts are hardcoded — the game's own structure schedule drives it.
  rclSchedule(type) {
    const table = this.caps[type] || {};
    const out = [];
    let prev = 0;
    for (let r = 1; r <= 8; r++) {
      const cap = table[r] || 0;
      for (let n = prev; n < cap; n++) out.push(r);
      prev = Math.max(prev, cap);
    }
    return out;
  }

  // Dijkstra from (sx,sy) over the 8-neighbourhood; `cost(x,y)` is the step cost
  // ONTO (x,y) (Infinity = impassable). Returns the distance field; `tracePath`
  // reconstructs a route from the stored predecessors. Uses the binary MinHeap
  // (O(E log V)) so the once-per-founding plan stays inside one tick's CPU budget.
  dijkstra(sx, sy, cost) {
    const dist = new Float64Array(SIZE * SIZE).fill(Infinity);
    const prev = new Int32Array(SIZE * SIZE).fill(-1);
    dist[idx(sx, sy)] = 0;
    const heap = new MinHeap();
    heap.push(0, idx(sx, sy));
    while (heap.size) {
      const { dist: d, node } = heap.pop();
      if (d > dist[node]) continue; // stale heap entry
      const x = node % SIZE;
      const y = (node / SIZE) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
          if (this.isWall(nx, ny)) continue;
          const c = cost(nx, ny);
          if (!isFinite(c)) continue;
          const nd = d + c;
          const ni = idx(nx, ny);
          if (nd < dist[ni]) {
            dist[ni] = nd;
            prev[ni] = node;
            heap.push(nd, ni);
          }
        }
      }
    }
    this._lastPrev = prev;
    return dist;
  }

  // Reconstruct the route to (tx,ty) from the predecessors of the LAST dijkstra
  // run. Returns the tiles from the start up to and including (tx,ty); if (tx,ty)
  // itself was impassable (e.g. the controller, glued to a wall), trace from the
  // reachable neighbour the field assigns the smallest distance.
  tracePath(field, tx, ty) {
    let endX = tx;
    let endY = ty;
    if (!isFinite(field[idx(tx, ty)])) {
      let bestD = Infinity;
      for (const n of this.walkableNeighbours(tx, ty)) {
        const d = field[idx(n.x, n.y)];
        if (d < bestD) {
          bestD = d;
          endX = n.x;
          endY = n.y;
        }
      }
      if (!isFinite(bestD)) return [];
    }
    const prev = this._lastPrev;
    const path = [];
    let cur = idx(endX, endY);
    while (cur !== -1) {
      path.push({ x: cur % SIZE, y: Math.floor(cur / SIZE) });
      cur = prev[cur];
    }
    return path.reverse();
  }

  // The finished plan: roads folded from the dedup map into the same shape.
  result() {
    const roads = [];
    for (const [k, rcl] of this.roadRcl) {
      const [x, y] = k.split(",").map(Number);
      roads.push({ x, y, rcl });
    }
    return { anchor: this.anchor, structures: this.structures, roads };
  }
}
