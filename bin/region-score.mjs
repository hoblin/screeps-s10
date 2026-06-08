#!/usr/bin/env node
// ============================================================================
//  region-score.mjs — full regional economic valuation of spawn candidates.
//
//  This is the model behind "which room should we claim". It goes beyond
//  counting sources (scan-season) and beyond home-room layout (geo-season):
//  it computes the REAL haul cost of every nearby source, including
//  remote-mining across room borders, with terrain-weighted pathfinding.
//
//  ---- Economic model -----------------------------------------------------
//  A source's value is energy-per-tick you can actually bank from it. A source
//  regenerates 3000 energy / 300 ticks = 10 e/t (own room) regardless of where
//  it sits — BUT realising that income costs hauler body & CPU proportional to
//  the round-trip distance. So we value a source as:
//
//      value(s) = BASE / (1 + k * roundTripDist(s))
//
//  where roundTripDist is the terrain-weighted path spawn<->source (there and
//  back), BASE encodes "a perfectly adjacent source is worth ~BASE", and k
//  tunes how fast distance erodes value. Own-room sources use BASE_HOME,
//  remote sources BASE_REMOTE (lower: they need reservers, are raidable, and
//  the road is longer/unprotected).
//
//  Remote haul crosses a room border. In Screeps a creep exiting at edge tile
//  (x=49,y) re-enters the neighbour at (x=0,y) — same coordinate on the shared
//  axis. So cross-border distance =
//        dist(source -> its exit tile toward home)         [in remote room]
//      + 1                                                 [the border step]
//      + dist(home entry tile -> spawn proxy)              [in home room]
//  We take the minimum over all valid exit tiles on the shared border.
//
//  Total region value:
//      V = Σ home sources value
//        + Σ remote sources value (orthogonal neighbours only; diagonals need
//          two hops and aren't worth remoting early)
//        + mineral bonus
//        - safety penalty (owned neighbours are dangerous / unmineable)
//
//  Reads the local SQLite mirror (tmp/season.db) only — zero API access. Run
//  the collector (bin/collect.mjs) first to populate rooms; scoring a room the
//  crawler hasn't reached yet reports it as not-collected.
//
//  Usage:
//    node bin/region-score.mjs --from tmp/season-geo.json --top 8
//    node bin/region-score.mjs W24S3 W24N7
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, loadRoom, parseRoom, roomName, resolveWorld } from "./db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag (e.g. --main)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
// Which world's mirror to score. --main reads tmp/shard2.db; default = Season.
// The shard is a report label here AND picks the DB file (no API access).
const W = resolveWorld({ main: arg("main", false) === true, shard: arg("shard", null) });
const SHARD = W.shard;
const OUT = arg("out", `tmp/${W.tag}-region.json`);
const ME = arg("me", null); // our own username/id — excluded from the enemy-threat field (we don't threaten ourselves)

// Data source: the SQLite mirror. Analytics is read-only and 100% offline by
// design — the dedicated crawler (collect.mjs) is the sole owner of API access
// and fills the DB. Scoring a room that hasn't been collected yet throws (run
// the collector first); we never fetch here. Opened lazily so importing this
// module for its exported model (e.g. heatmap.mjs) has no side effects.
let _db = null;
const db = () => (_db ??= openDb(W.dbPath));

// ---- tuning constants ------------------------------------------------------
// Economy core (v1): a source's bankable value, distance-decayed.
// Resource lever: a colony is worth the SOURCE NODES it can work — home (owned, 10 e/t) plus reachable
// neutral remotes (reserved, 10 e/t each). COUNT is the lever; distance is haul OVERHEAD, not a value
// cliff (you build roads — a 50-tile remote still nets ~8 e/t, not ~1). So the taper is GENTLE: a remote
// source counts nearly as much as a home one, and a room with more workable sources wins. A remote is
// weighted a bit below home (reserver cost + raid risk + longer road).
const BASE_HOME = 100;  // a worked home source
const BASE_REMOTE = 75; // a reserved remote source — ~75% of a home source, still a full 10 e/t node
const K = 0.02; // distance decay (round-trip tiles, terrain-weighted via crossBorderDist so SWAMP costs
                // 5×). Middle ground: count still drives the score, but a far / swampy remote is properly
                // discounted (a swamp-maze neighbour is NOT worth a clean adjacent one). 0.04 was a cliff
                // (distance killed value), 0.008 was too soft (swamp/distance ignored).
const ONE_SOURCE_PENALTY = 0.4; // a 1-source room is a weak main (half the income) — heavily deprioritised.
const MINERAL_BONUS = { U: 18, X: 18, K: 14, L: 14, Z: 12, O: 8, H: 8 };

// Additive v2 terms — all in the same ~100-per-source units as the economy
// core so they tune transparently. Each is documented with the fact it encodes
// and is only as informed as the scan: SK lairs, controller level, reservation
// and highway access come from the v2 room fields, so a room scored from a v1
// (un-rescanned) row falls back to the old economy-only behaviour.
const BASE_SK = 40;        // a Source-Keeper source: fat (4000e/regen, ~33% over
                           // a normal 3000e source) but guarded — only mineable
                           // at Stage-4 with boosted clearers, past keeper lairs.
                           // ~70% of BASE_REMOTE: the fatness partly offsets the
                           // clearing cost, the discount books the late-game delay.
const SK_MINERAL_BONUS = 10;  // an SK room's mineral is a free late-game extractor site.
// Enemy-threat FIELD: a rival threatens a candidate by PROXIMITY × their PEAK
// capability — their MAIN room's RCL, NOT the RCL of a forward outpost they pushed
// at you. A veteran's RCL-2 forward base is backed by an RCL-8 main that can field a
// boosted army; a noob's RCL-2 sole base can't. So weight every one of a player's
// presences by their empire-wide ceiling (main RCL), and discount with room distance.
const THREAT_RADIUS = 6;       // room-hops beyond which a rival barely projects force at a fresh colony
const THREAT_PER_RCL = 14;     // threat weight per level of the rival's MAIN room (peak capability)
const THREAT_PER_EMPIRE = 5;   // extra threat per ADDITIONAL base — a sprawling empire fields more army
// Threat is a RISK DISCOUNT on the resource value, NOT a subtraction (subtracting let a safe-but-empty
// room outrank a rich contested one — forgetting a 2nd base exists to MINE). It scales economy by a
// factor in [THREAT_FLOOR, 1]: a fresh colony next to a strong veteran is worth a fraction, never zero
// (claim it anyway if it's rich enough), and a resource-poor room ranks low on its own merit regardless.
const THREAT_FULL = 200;       // threat at which the discount bottoms out at THREAT_FLOOR
const THREAT_FLOOR = 0.25;     // a maximally-threatened room still keeps this fraction of its resource value
const RESERVED_REMOTE_FACTOR = 0.35; // a neighbour reserved by someone else isn't a free remote.
const NO_CONTROLLER_FACTOR = 0.5;    // a controller-less neutral remote can't be reserved → sources at 5 e/t, not 10.
const CHOKE_MAX_BONUS = 20;    // a near-sealed room (few open border tiles) is cheap to wall.
const CHOKE_OPEN_REF = 160;    // open-exit-tile count at which the choke bonus fades to zero.
const HIGHWAY_ACCESS_BONUS = 6; // adjacency to a highway = deposit/power/portal reach later.

// A room is on a highway when either coordinate number is a multiple of 10
// (the sector grid lines). Highway rooms host deposits / power banks / portals.
function isHighway(nm) {
  const m = nm.match(/^[WE](\d+)[NS](\d+)$/);
  return !!m && (+m[1] % 10 === 0 || +m[2] % 10 === 0);
}

// ---- terrain (standard Screeps row-major: index = y*50 + x) ------------------
// Matches the live engine's getTerrain().get(x,y), verified against the season
// server: a real PathFinder path is wall-free only under y*50+x, and the built
// spawn (which cannot occupy a wall) lands on a non-wall tile only under y*50+x.
// The earlier x*50+y "fix" rested on a false premise — natural objects (controller,
// sources, mineral) CAN sit on wall tiles, so "objects on non-walls" proved nothing.
// See thoughts/shared/notes/2026-06-04/screeps-terrain-standard-not-transposed.md (#111).
const idx = (x, y) => y * 50 + x;
const isWall = (g, x, y) => x < 0 || y < 0 || x > 49 || y > 49 || (g[idx(x, y)] & 1) === 1;
const tcost = (g, x, y) => ((g[idx(x, y)] & 2) === 2 ? 5 : 1);
// Terrain decoding lives in db.mjs (parseTerrain) so loadRoom is the single
// source of the grid; region-score only consumes it.

// Dijkstra distance field from one start tile (terrain-weighted).
function distField(g, sx, sy) {
  const dist = new Float32Array(2500).fill(Infinity);
  dist[idx(sx, sy)] = 0;
  const pq = [[0, sx, sy]];
  while (pq.length) {
    let mi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[mi][0]) mi = i;
    const [d, x, y] = pq.splice(mi, 1)[0];
    if (d > dist[idx(x, y)]) continue;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (isWall(g, nx, ny)) continue;
        const nd = d + tcost(g, nx, ny);
        if (nd < dist[idx(nx, ny)]) {
          dist[idx(nx, ny)] = nd;
          pq.push([nd, nx, ny]);
        }
      }
  }
  return dist;
}

// Distance to a SOURCE/controller as a creep actually experiences it: the min field
// value over the object's own tile AND its walkable neighbours. A source or controller
// may LEGALLY sit on a wall tile (#111 — natural objects can) — you can't stand on it,
// so its own tile never gets a finite distField value; the real cost is to the adjacent
// tile a miner/hauler stands on. Reading the object tile directly returned Infinity for
// every wall-mounted source, zeroing home value (the home=0 bug). Mirrors how the remote
// path already floods FROM the source's surroundings rather than the source tile.
function accessDist(g, field, x, y) {
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const nx = x + dx, ny = y + dy;
      if (isWall(g, nx, ny)) continue; // can't stand on a wall
      const d = field[idx(nx, ny)];
      if (d < best) best = d;
    }
  return best;
}

// ---- room name math --------------------------------------------------------
// orthogonal neighbours with the border direction relative to home.
// Room-name <-> coord math is single-sourced in db.mjs (parseRoom/roomName).
function orthoNeighbours(nm) {
  const { sx, sy } = parseRoom(nm);
  return [
    { dir: "W", room: roomName(sx - 1, sy) }, // west: home x=0 border <-> neighbour x=49
    { dir: "E", room: roomName(sx + 1, sy) }, // east: home x=49 <-> neighbour x=0
    { dir: "N", room: roomName(sx, sy + 1) }, // north: home y=0 <-> neighbour y=49
    { dir: "S", room: roomName(sx, sy - 1) }, // south: home y=49 <-> neighbour y=0
  ];
}

// Room facts come straight from the SQLite mirror. loadRoom returns null for a
// room the crawler hasn't reached yet — we surface that as an error rather than
// silently fetching, keeping analytics free of API access. (Named requireRoom,
// not fetchRoom, to avoid confusion with collect.mjs's live-API fetcher.)
function requireRoom(nm) {
  const room = loadRoom(db(), nm);
  if (!room) throw new Error(`${nm} not collected (run bin/collect.mjs)`);
  return room;
}

// Passable border tiles on the home edge that faces a neighbour in room-direction
// `dir`, as [x,y]. Standard Screeps adjacency: the room to the W/E shares our
// x=0 / x=49 edge (same y), the room to the N/S shares our y=0 / y=49 edge (same x)
// — confirmed against the season server's native PathFinder exit tiles (a west
// crossing leaves home at x=0 and re-enters the neighbour at x=49, same y).
function borderTiles(g, dir) {
  const tiles = [];
  for (let i = 1; i < 49; i++) {
    let x, y;
    if (dir === "W") [x, y] = [0, i]; // room W <-> our W edge (x=0)
    else if (dir === "E") [x, y] = [49, i]; // room E <-> our E edge (x=49)
    else if (dir === "N") [x, y] = [i, 0]; // room N <-> our N edge (y=0)
    else [x, y] = [i, 49]; // room S <-> our S edge (y=49)
    if (!isWall(g, x, y)) tiles.push([x, y]);
  }
  return tiles;
}
// Map a home border tile to the shared tile in the neighbour. Standard exit-tile
// mechanic: a creep leaving at x=0 re-enters the west neighbour at x=49 (same y),
// and leaving at y=0 re-enters the north neighbour at y=49 (same x).
function mirror(dir, x, y) {
  if (dir === "W") return [49, y]; // home (0,i) -> neighbour (49,i)
  if (dir === "E") return [0, y]; // home (49,i) -> neighbour (0,i)
  if (dir === "N") return [x, 49]; // home (i,0) -> neighbour (i,49)
  return [x, 0]; // S: home (i,49) -> neighbour (i,0)
}

const valueOf = (base, d) => (isFinite(d) ? base / (1 + K * d) : 0);

// Cheapest terrain-weighted distance from a neighbour source to the home spawn
// proxy, crossing the shared border. Returns Infinity when the border is walled
// off (source physically unreachable from home). Shared by normal and SK remotes.
function crossBorderDist(home, homeField, nb, dir, s) {
  const nbField = distField(nb.g, s.x, s.y);
  let best = Infinity;
  for (const [hx, hy] of borderTiles(home.g, dir)) {
    const [mx, my] = mirror(dir, hx, hy);
    if (isWall(nb.g, mx, my)) continue;
    const d = homeField[idx(hx, hy)] + 1 + nbField[idx(mx, my)];
    if (d < best) best = d;
  }
  return best;
}

// Defensibility proxy: the fewer passable border tiles a room has, the cheaper
// it is to wall off. Scales from CHOKE_MAX_BONUS (near-sealed) to 0 (wide open).
function chokeBonus(g) {
  let open = 0;
  for (const dir of ["W", "E", "N", "S"]) open += borderTiles(g, dir).length;
  return CHOKE_MAX_BONUS * Math.max(0, 1 - open / CHOKE_OPEN_REF);
}

// The current player landscape, built ONCE from the SQLite mirror (lazy + cached):
//   • byRoom   — name -> { owner, uname, level }: who holds each room and at what
//                level. level >= 1 = a CLAIMED base; level 0 = a RESERVATION (a
//                remote, not a base). Prefers the fresh `ownership` sweep
//                (collect.mjs --owners), falling back to the pre-season room scan's
//                controller owner for rooms not yet re-swept. We key on `own` only —
//                a controller `sign` is cosmetic map graffiti (one player can sign
//                the whole map) and is NEVER read here.
//   • profiles — one per RIVAL: { owner, name, mainRcl, empire, bases:[{sx,sy}] }.
//                A rival's THREAT weight is their MAIN room RCL (peak capability) and
//                empire size, not the local RCL of any one base. Reservations (level
//                0) do NOT raise mainRcl — only claimed bases do. `me` is excluded.
const NPC_OWNERS = new Set(["Invader", "Source Keeper"]); // NPC owners — local hazards (the in-game guard
// handles them), NOT rival empires; excluded from the player-threat field so their map-wide cores don't
// inflate an "empire" term and swamp every candidate.
function buildLandscape(database, me) {
  const isMe = (owner, uname) => me && (owner === me || uname === me);
  const rows = database.prepare(
    `SELECT name, owner, owner_name AS uname, level FROM ownership WHERE owner IS NOT NULL`,
  ).all();
  const seen = new Set(rows.map((r) => r.name));
  // Fallback: rooms the cheap --owners sweep hasn't covered keep their pre-season
  // scanned controller owner (better stale than blind).
  for (const r of database.prepare(
    `SELECT name, controller_owner AS owner, controller_owner_name AS uname, controller_level AS level
       FROM rooms WHERE controller_owner IS NOT NULL`,
  ).all()) if (!seen.has(r.name)) rows.push(r);

  const byRoom = new Map();
  const byOwner = new Map();
  for (const r of rows) {
    const level = r.level || 0;
    byRoom.set(r.name, { owner: r.owner, uname: r.uname, level });
    // Skip: reservations (level 0), our own bases, and NPC owners (Invader / Source
    // Keeper — local hazards the in-game guard handles, not rival empires to avoid).
    if (level < 1 || isMe(r.owner, r.uname) || NPC_OWNERS.has(r.uname)) continue;
    const p = byOwner.get(r.owner) || { owner: r.owner, name: r.uname, mainRcl: 0, empire: 0, bases: [] };
    p.bases.push(r.name); // the room NAME — the threat field walks the real room graph, not grid offsets
    p.empire++;
    if (level > p.mainRcl) p.mainRcl = level;
    if (!p.name && r.uname) p.name = r.uname;
    byOwner.set(r.owner, p);
  }
  return { byRoom, profiles: [...byOwner.values()] };
}
let _land = null;
const land = () => (_land ??= buildLandscape(db(), ME));

// Two ortho-adjacent rooms CONNECT when the shared border has at least one tile pair
// passable on both sides (a creep can actually cross). Reuses the same border/mirror
// primitives the remote haul-distance model uses — geography, not grid offsets.
function bordersConnect(ag, dir, bg) {
  for (const [hx, hy] of borderTiles(ag, dir)) {
    const [mx, my] = mirror(dir, hx, hy);
    if (!isWall(bg, mx, my)) return true;
  }
  return false;
}

// Room-graph BFS from `start`, flooding only ACTUALLY-CONNECTED, scanned rooms up to
// `maxHops`. Returns Map(room -> hop distance). This is the real "can a creep march
// here" metric: a base that is grid-near but walled off / behind unscanned space is
// correctly far or unreachable, NOT the lie a Manhattan offset tells. An unscanned room
// breaks the path (unknown terrain isn't trusted as a route).
//
// `blocked(name, facts)` (optional) marks a room IMPASSABLE for this traversal, so the
// BFS routes AROUND it. Two callers, two semantics: the enemy-threat field passes none
// (an enemy ARMY marches through SK/enemy rooms — they stay passable), while the home-
// support distance passes `supportBlocked` (OUR economy creeps die in SK/invader/enemy
// rooms, so the safe supply route goes around them — the E12S5 "4 hops through 2 SK" vs
// the real 5 safe hops lesson).
function connectedDist(start, maxHops, blocked = null) {
  const dist = new Map([[start, 0]]);
  let frontier = [start];
  for (let h = 0; h < maxHops && frontier.length; h++) {
    const next = [];
    for (const room of frontier) {
      let a; try { a = requireRoom(room); } catch { continue; }
      for (const { dir, room: nb } of orthoNeighbours(room)) {
        if (dist.has(nb)) continue;
        let b; try { b = requireRoom(nb); } catch { continue; } // unscanned => not a trusted route
        if (!bordersConnect(a.g, dir, b.g)) continue;
        if (blocked && blocked(nb, b)) continue; // impassable for this traversal → route around
        dist.set(nb, h + 1);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return dist;
}

// Rooms OUR economy creeps (claimer, pioneers, haulers) can't safely march THROUGH when
// supporting a forward base: Source-Keeper rooms (keepers kill non-combat creeps),
// invader-core rooms, and enemy CLAIMED bases. Mirrors the live bot's danger-aware
// corridor (src/lib/Routing.js blocks SK by room-coordinate). Our own bases/reservations
// stay passable — we hold them.
function supportBlocked(name, facts) {
  if (facts.keeperLairs?.length > 0) return true;
  if (facts.invaderCore) return true;
  const occ = land().byRoom.get(name);
  return !!(occ && occ.level >= 1 && !(ME && (occ.owner === ME || occ.uname === ME)));
}

// Safe support distance: connected hops from `start` that route AROUND danger — the real
// "how far to send a claimer + pioneer seed, and to haul back from" metric for a forward
// base. The honest replacement for the SK-blind hop count.
function supportDist(start, maxHops) {
  return connectedDist(start, maxHops, supportBlocked);
}

// Enemy-threat at a candidate: Σ over rivals of weight × distance-decay, where weight
// = THREAT_PER_RCL · mainRcl + THREAT_PER_EMPIRE · (empire-1) — the rival's PEAK
// capability — and decay falls from 1 at an adjacent base to 0 at THREAT_RADIUS. The
// distance is REAL connected room-hops to the rival's nearest reachable base (BFS over
// the passable room graph), so a base he can't actually march an army from — walled
// off, or beyond the radius — doesn't threaten this candidate.
function enemyThreat(nm, profiles) {
  const dmap = connectedDist(nm, THREAT_RADIUS);
  let threat = 0;
  const contributors = [];
  for (const p of profiles) {
    let near = Infinity;
    for (const room of p.bases) {
      const d = dmap.get(room);
      if (d != null && d < near) near = d;
    }
    if (!isFinite(near) || near < 1) continue; // unreachable within radius
    const decay = 1 - (near - 1) / THREAT_RADIUS;
    if (decay <= 0) continue;
    const weight = THREAT_PER_RCL * p.mainRcl + THREAT_PER_EMPIRE * (p.empire - 1);
    const t = weight * decay;
    if (t <= 0) continue;
    threat += t;
    contributors.push({ player: p.name || p.owner, mainRcl: p.mainRcl, empire: p.empire, dist: near, threat: round(t) });
  }
  contributors.sort((a, b) => b.threat - a.threat);
  return { threat, contributors };
}

async function scoreRoom(nm) {
  const home = requireRoom(nm);
  if (!home.controller) return { room: nm, error: "no controller (unclaimable)" };
  // Unclaimable only if it's a CLAIMED base (level >= 1). A room merely RESERVED
  // (level 0 — including our own remotes) is a perfectly valid claim candidate, so we
  // key on the fresh ownership level, not loadRoom's reservation-conflated `owner`.
  const occHome = land().byRoom.get(nm);
  if (occHome && occHome.level >= 1) return { room: nm, error: `already owned (${occHome.uname || occHome.owner})` };

  // spawn proxy = controller tile (planner will place spawn nearby; relative
  // haul cost from controller is a stable proxy pre-planning).
  const homeField = distField(home.g, home.controller.x, home.controller.y);

  // -- home sources --
  const homeSrc = home.sources.map((s) => {
    const oneWay = accessDist(home.g, homeField, s.x, s.y); // to the miner's standable tile, not the (maybe-wall) source tile
    const rt = oneWay * 2;
    return { ...s, dist: round(oneWay), value: round(valueOf(BASE_HOME, rt)) };
  });
  const homeValue = homeSrc.reduce((a, s) => a + s.value, 0);

  // -- orthogonal neighbours: remotes, SK rooms, enemies, reservation, highway --
  const remotes = [];   // immediately mineable neutral remotes
  const skRemotes = []; // guarded Source-Keeper rooms (discounted, late-game)
  const skNeighbours = [];
  let enemyNeighbours = 0;
  let reservedNeighbours = 0, highwayAccess = false;
  const neighbours = []; // per-ortho-exit classification so the top-N display shows WHY a room is
                         // good/bad — e.g. all exits into invader rooms = a boxed-in trap.

  for (const { dir, room } of orthoNeighbours(nm)) {
    if (isHighway(room)) highwayAccess = true;
    let nb;
    try { nb = requireRoom(room); } catch { neighbours.push({ dir, room, type: "?" }); continue; } // un-collected

    const occ = land().byRoom.get(room);
    // An invader stronghold (NPC) is a TRAP exit — you path into hostiles, never a remote. A CLAIMED
    // player base can't be remote-mined either; it's the enemy-threat field's input (scored by main-RCL
    // × distance below), so a base merely BORDERING us is just one dist-1 contributor there.
    if (nb.invaderCore || (occ && NPC_OWNERS.has(occ.uname))) { neighbours.push({ dir, room, type: "invader" }); continue; }
    if (occ && occ.level >= 1) { enemyNeighbours++; neighbours.push({ dir, room, type: `base:${occ.uname || occ.owner}` }); continue; }

    // Source-Keeper room (keeper lairs present): a fat late-game remote, not a
    // free one. Value its sources at the discounted BASE_SK plus its mineral,
    // and keep it out of the immediate-remote bucket. (Needs v2 scan data; a
    // v1 row reports no lairs and the room falls through as a normal remote.)
    if (nb.keeperLairs.length > 0) {
      let skVal = 0;
      for (const s of nb.sources) skVal += valueOf(BASE_SK, crossBorderDist(home, homeField, nb, dir, s) * 2);
      if (nb.mineral) skVal += SK_MINERAL_BONUS;
      skRemotes.push({ room, sources: nb.sources.length, mineral: nb.mineral?.t || null, value: round(skVal) });
      skNeighbours.push(room);
      neighbours.push({ dir, room, type: "sk", srcs: nb.sources.length });
      continue;
    }

    if (nb.sources.length === 0) { neighbours.push({ dir, room, type: nb.controller ? "empty" : "highway" }); continue; }

    // Reserved by ANOTHER player (level 0 with an owner that isn't us) => contested,
    // discount the remote. Our OWN reservation is a remote we already work — full value.
    const reservedByOther = !!(occ && occ.owner && !(ME && (occ.owner === ME || occ.uname === ME)));
    if (reservedByOther) reservedNeighbours++;
    // A remote's sources only yield the full 10 e/t if we can RESERVE the room — which
    // needs a controller. A controller-less neutral room can't be reserved, so its
    // sources sit at the unreserved 5 e/t (half value). (SK rooms are handled above.)
    const reservable = !!nb.controller;
    let factor = reservedByOther ? RESERVED_REMOTE_FACTOR : 1;
    if (!reservable) factor *= NO_CONTROLLER_FACTOR;

    for (const s of nb.sources) {
      const best = crossBorderDist(home, homeField, nb, dir, s);
      // best === Infinity => shared border walled off; source unreachable from
      // home. Recorded as cut-off (value 0) so count-rich-but-walled regions
      // are correctly penalised.
      const reachable = isFinite(best);
      remotes.push({
        room, dir, x: s.x, y: s.y,
        dist: reachable ? round(best) : null,
        reachable, reserved: reservedByOther,
        value: reachable ? round(valueOf(BASE_REMOTE, best * 2) * factor) : 0,
      });
    }
    neighbours.push({ dir, room, type: reservedByOther ? `resv:${occ.uname || occ.owner}` : occ ? "mine" : "free", srcs: nb.sources.length });
  }
  const remoteValue = remotes.reduce((a, s) => a + s.value, 0);
  const skValue = skRemotes.reduce((a, s) => a + s.value, 0);

  const mineralBonus = home.mineral ? (MINERAL_BONUS[home.mineral.t] || 6) : 0;
  const choke = chokeBonus(home.g);
  const highwayBonus = highwayAccess ? HIGHWAY_ACCESS_BONUS : 0;
  // RESOURCES are the lever — a 2nd base exists to MINE. The backbone is the WORKABLE source value:
  // home (owned) + reachable neutral remotes, count-dominant via the gentle taper. SK sources are NOT
  // in it (un-minable until Stage-4 boosted clearers) — they're reported separately, not banked here. A
  // 1-source room is a weak main, penalised. Threat DISCOUNTS the backbone (a risk multiplier in
  // [FLOOR,1]) rather than subtracting — a contested-but-rich room still beats a safe-but-empty one.
  // Mineral (late-game asset), defensibility (choke) and highway access are small flat add-ons: they
  // help, but never manufacture a colony out of a room with nothing to mine.
  const { threat, contributors } = enemyThreat(nm, land().profiles);
  const oneSrc = home.sources.length >= 2 ? 1 : ONE_SOURCE_PENALTY;
  const economy = (homeValue + remoteValue) * oneSrc;
  const risk = Math.max(THREAT_FLOOR, 1 - threat / THREAT_FULL);
  const total = round(economy * risk + mineralBonus + choke + highwayBonus);

  return {
    room: nm,
    total,
    homeValue: round(homeValue),
    remoteValue: round(remoteValue),
    skValue: round(skValue),
    mineralBonus,
    chokeBonus: round(choke),
    highwayBonus,
    mineral: home.mineral?.t || null,
    enemyNeighbours,
    threat: round(threat),
    risk: round(risk, 2), // resource-value multiplier in [THREAT_FLOOR, 1] (1 = safe)
    threats: contributors, // top rival contributors: { player, mainRcl, empire, dist, threat }
    neighbours, // per-ortho-exit classification: free/mine/resv/sk/base/invader/empty/highway/?
    reservedNeighbours,
    highwayAccess,
    skNeighbours,
    homeSources: homeSrc.map((s) => ({ x: s.x, y: s.y, dist: s.dist, value: s.value })),
    remoteSources: remotes.sort((a, b) => b.value - a.value),
    skRemotes: skRemotes.sort((a, b) => b.value - a.value),
  };
}
const round = (n, p = 1) => (isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

async function main() {
  let targets = process.argv.slice(2).filter((a) => /^[WE]\d+[NS]\d+$/.test(a));
  const fromFile = arg("from", null);
  if (fromFile) {
    const top = parseInt(arg("top", "8"), 10);
    const d = JSON.parse(readFileSync(fromFile, "utf8"));
    const list = d.rooms || d.candidates || [];
    targets = list.filter((r) => !r.error).slice(0, top).map((r) => r.room);
  }
  if (!targets.length) {
    console.error("No targets. Pass room names or --from <json> --top N");
    process.exit(1);
  }
  console.log(`Regional valuation of ${targets.length} rooms @ ${SHARD}\n`);
  const out = [];
  for (const r of targets) {
    try { out.push(await scoreRoom(r)); }
    catch (e) { out.push({ room: r, error: String(e.message || e) }); }
  }
  out.sort((a, b) => (b.total ?? -1e9) - (a.total ?? -1e9));

  console.log("room      TOTAL   src    home   remote  sk     choke  hw   mineral  threat(rival·mainRCL@hops)  | SK-neigh / topRemote(dist)");
  for (const r of out) {
    if (r.error) { console.log(`${r.room.padEnd(8)}  ERROR: ${r.error}`); continue; }
    const reach = r.remoteSources.filter((s) => s.reachable);
    const cut = r.remoteSources.length - reach.length;
    const sk = r.skNeighbours.length ? `SK:${r.skNeighbours.join(",")}  ` : "";
    const tr = reach.slice(0, 3).map((s) => `${s.room}:${s.dist}`).join(" ") + (cut ? `  (+${cut} walled)` : "");
    const src = `${r.homeSources.length}+${reach.length}`; // home source nodes + reachable remote source nodes
    const top = r.threats?.[0];
    const threatStr = `${r.threat || 0}${top ? ` ${top.player}·L${top.mainRcl}@${top.dist}` : ""}`;
    console.log(
      `${r.room.padEnd(8)}  ${String(r.total).padEnd(6)}  ${src.padEnd(5)}  ${String(r.homeValue).padEnd(5)}  ${String(r.remoteValue).padEnd(6)}  ` +
      `${String(r.skValue).padEnd(5)}  ${String(r.chokeBonus).padEnd(5)}  ${String(r.highwayBonus).padEnd(3)}  ` +
      `${String(r.mineral || "-").padEnd(7)}  ${threatStr.padEnd(16)}  | ${sk}${tr}`,
    );
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ shard: SHARD, at: new Date().toISOString(), rooms: out }, null, 2));
  console.log(`\nFull -> ${OUT}`);
}
// scoreRoom is exported so downstream tools (bin/heatmap.mjs) can reuse the
// exact economic model over the whole collected grid without duplicating it.
// The remote-valuation primitives are exported too so bin/expansion-map.mjs can
// value an OWNED home room's remotes — scoreRoom itself refuses owned rooms (it
// scores claim candidates), but the underlying model is the same (extract-and-
// share per CLAUDE.md, not copy-paste).
export { scoreRoom, distField, crossBorderDist, valueOf, orthoNeighbours, connectedDist, supportDist, BASE_REMOTE, K };

// Only run the CLI when invoked directly, not when imported as a module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error("region-score failed:", e.message || e); process.exit(1); });
}
