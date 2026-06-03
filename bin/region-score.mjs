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
import { openDb, loadRoom, parseRoom, roomName } from "./db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SHARD = arg("shard", "shardSeason"); // report label only — no API access
const OUT = arg("out", "tmp/season-region.json");

// Data source: the SQLite mirror. Analytics is read-only and 100% offline by
// design — the dedicated crawler (collect.mjs) is the sole owner of API access
// and fills the DB. Scoring a room that hasn't been collected yet throws (run
// the collector first); we never fetch here. Opened lazily so importing this
// module for its exported model (e.g. heatmap.mjs) has no side effects.
let _db = null;
const db = () => (_db ??= openDb());

// ---- tuning constants ------------------------------------------------------
// Economy core (v1): a source's bankable value, distance-decayed.
const BASE_HOME = 100; // value of a perfectly-adjacent own source
const BASE_REMOTE = 55; // remote source worth ~half: reserver + risk + road
const K = 0.04; // distance decay; at 25 tiles a source keeps 1/(1+1)=50%
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
const ENEMY_BASE_PENALTY = 18; // any hostile neighbour costs you map control...
const ENEMY_PER_LEVEL = 6;     // ...scaled by their RCL: an L1 squatter ≠ an L8 fortress.
const RESERVED_REMOTE_FACTOR = 0.35; // a neighbour reserved by someone else isn't a free remote.
const CHOKE_MAX_BONUS = 20;    // a near-sealed room (few open border tiles) is cheap to wall.
const CHOKE_OPEN_REF = 160;    // open-exit-tile count at which the choke bonus fades to zero.
const HIGHWAY_ACCESS_BONUS = 6; // adjacency to a highway = deposit/power/portal reach later.

// A room is on a highway when either coordinate number is a multiple of 10
// (the sector grid lines). Highway rooms host deposits / power banks / portals.
function isHighway(nm) {
  const m = nm.match(/^[WE](\d+)[NS](\d+)$/);
  return !!m && (+m[1] % 10 === 0 || +m[2] % 10 === 0);
}

// ---- terrain (transposed on this season server: index = x*50 + y) ----------
const idx = (x, y) => x * 50 + y;
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

// All passable border tiles on a given side, as [x,y].
function borderTiles(g, dir) {
  const tiles = [];
  for (let i = 1; i < 49; i++) {
    let x, y;
    if (dir === "W") [x, y] = [0, i];
    else if (dir === "E") [x, y] = [49, i];
    else if (dir === "N") [x, y] = [i, 0];
    else [x, y] = [i, 49];
    if (!isWall(g, x, y)) tiles.push([x, y]);
  }
  return tiles;
}
// shared-axis coordinate maps: exiting at (49,y) enters neighbour at (0,y).
function mirror(dir, x, y) {
  if (dir === "W") return [49, y]; // home x=0 -> neighbour x=49
  if (dir === "E") return [0, y]; // home x=49 -> neighbour x=0
  if (dir === "N") return [x, 49]; // home y=0 -> neighbour y=49
  return [x, 0]; // home y=49 -> neighbour y=0
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

async function scoreRoom(nm) {
  const home = requireRoom(nm);
  if (!home.controller) return { room: nm, error: "no controller (unclaimable)" };
  if (home.owner) return { room: nm, error: "already owned" };

  // spawn proxy = controller tile (planner will place spawn nearby; relative
  // haul cost from controller is a stable proxy pre-planning).
  const homeField = distField(home.g, home.controller.x, home.controller.y);

  // -- home sources --
  const homeSrc = home.sources.map((s) => {
    const oneWay = homeField[idx(s.x, s.y)];
    const rt = oneWay * 2;
    return { ...s, dist: round(oneWay), value: round(valueOf(BASE_HOME, rt)) };
  });
  const homeValue = homeSrc.reduce((a, s) => a + s.value, 0);

  // -- orthogonal neighbours: remotes, SK rooms, enemies, reservation, highway --
  const remotes = [];   // immediately mineable neutral remotes
  const skRemotes = []; // guarded Source-Keeper rooms (discounted, late-game)
  const skNeighbours = [];
  let enemyNeighbours = 0, enemyPenalty = 0, nearestEnemyRcl = null;
  let reservedNeighbours = 0, highwayAccess = false;

  for (const { dir, room } of orthoNeighbours(nm)) {
    if (isHighway(room)) highwayAccess = true;
    let nb;
    try { nb = requireRoom(room); } catch { continue; } // skip un-collected neighbours

    // Enemy-owned: can't remote-mine, and they cost map control scaled by RCL.
    if (nb.owner) {
      enemyNeighbours++;
      const lvl = nb.controller?.level ?? 0;
      enemyPenalty += ENEMY_BASE_PENALTY + ENEMY_PER_LEVEL * lvl;
      if (nearestEnemyRcl == null || lvl > nearestEnemyRcl) nearestEnemyRcl = lvl;
      continue;
    }

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
      continue;
    }

    if (nb.sources.length === 0) continue;

    // Reserved by someone else => contested, discount the remote (not yet free).
    const reservedByOther = !!nb.reservation?.owner;
    if (reservedByOther) reservedNeighbours++;
    const factor = reservedByOther ? RESERVED_REMOTE_FACTOR : 1;

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
  }
  const remoteValue = remotes.reduce((a, s) => a + s.value, 0);
  const skValue = skRemotes.reduce((a, s) => a + s.value, 0);

  const mineralBonus = home.mineral ? (MINERAL_BONUS[home.mineral.t] || 6) : 0;
  const choke = chokeBonus(home.g);
  const highwayBonus = highwayAccess ? HIGHWAY_ACCESS_BONUS : 0;
  const safety = -enemyPenalty;
  const total = round(homeValue + remoteValue + skValue + mineralBonus + choke + highwayBonus + safety);

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
    enemyPenalty: round(enemyPenalty),
    nearestEnemyRcl,
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

  console.log("room      TOTAL   home   remote  sk     choke  hw   mineral  enemy(rcl)  | SK-neigh / topRemote(dist)");
  for (const r of out) {
    if (r.error) { console.log(`${r.room.padEnd(8)}  ERROR: ${r.error}`); continue; }
    const reach = r.remoteSources.filter((s) => s.reachable);
    const cut = r.remoteSources.length - reach.length;
    const sk = r.skNeighbours.length ? `SK:${r.skNeighbours.join(",")}  ` : "";
    const tr = reach.slice(0, 3).map((s) => `${s.room}:${s.dist}`).join(" ") + (cut ? `  (+${cut} walled)` : "");
    const enemy = `${r.enemyNeighbours}${r.nearestEnemyRcl != null ? `(L${r.nearestEnemyRcl})` : ""}`;
    console.log(
      `${r.room.padEnd(8)}  ${String(r.total).padEnd(6)}  ${String(r.homeValue).padEnd(5)}  ${String(r.remoteValue).padEnd(6)}  ` +
      `${String(r.skValue).padEnd(5)}  ${String(r.chokeBonus).padEnd(5)}  ${String(r.highwayBonus).padEnd(3)}  ` +
      `${String(r.mineral || "-").padEnd(7)}  ${enemy.padEnd(10)}  | ${sk}${tr}`,
    );
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ shard: SHARD, at: new Date().toISOString(), rooms: out }, null, 2));
  console.log(`\nFull -> ${OUT}`);
}
// scoreRoom is exported so downstream tools (bin/heatmap.mjs) can reuse the
// exact economic model over the whole collected grid without duplicating it.
export { scoreRoom };

// Only run the CLI when invoked directly, not when imported as a module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error("region-score failed:", e.message || e); process.exit(1); });
}
