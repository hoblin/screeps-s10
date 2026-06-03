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

// tuning constants
const BASE_HOME = 100; // value of a perfectly-adjacent own source
const BASE_REMOTE = 55; // remote source worth ~half: reserver + risk + road
const K = 0.04; // distance decay; at 25 tiles a source keeps 1/(1+1)=50%
const MINERAL_BONUS = { U: 18, X: 18, K: 14, L: 14, Z: 12, O: 8, H: 8 };
const ENEMY_NEIGHBOUR_PENALTY = 40;

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

  // -- remote (orthogonal) sources --
  const remotes = [];
  let enemyNeighbours = 0;
  for (const { dir, room } of orthoNeighbours(nm)) {
    let nb;
    try { nb = requireRoom(room); } catch { continue; } // skip un-collected neighbours
    if (nb.owner) { enemyNeighbours++; continue; } // can't remote-mine enemy
    if (nb.sources.length === 0) continue;
    // home-side border field already in homeField; precompute neighbour field
    // per source below. For each source, find the cheapest border crossing.
    for (const s of nb.sources) {
      const nbField = distField(nb.g, s.x, s.y); // dist from source to anywhere in neighbour
      let best = Infinity;
      // iterate home border tiles on this side; map to neighbour entry tile
      for (const [hx, hy] of borderTiles(home.g, dir)) {
        const [mx, my] = mirror(dir, hx, hy);
        if (isWall(nb.g, mx, my)) continue;
        const d = homeField[idx(hx, hy)] + 1 + nbField[idx(mx, my)];
        if (d < best) best = d;
      }
      // best === Infinity => the shared border is walled off; source is
      // physically unreachable from home. Record it as cut-off (value 0) so
      // count-rich-but-walled regions are correctly penalised.
      const reachable = isFinite(best);
      const rt = best * 2;
      remotes.push({
        room, dir, x: s.x, y: s.y,
        dist: reachable ? round(best) : null,
        reachable,
        value: reachable ? round(valueOf(BASE_REMOTE, rt)) : 0,
      });
    }
  }
  const remoteValue = remotes.reduce((a, s) => a + s.value, 0);

  const mineralBonus = home.mineral ? (MINERAL_BONUS[home.mineral.t] || 6) : 0;
  const safety = -enemyNeighbours * ENEMY_NEIGHBOUR_PENALTY;
  const total = round(homeValue + remoteValue + mineralBonus + safety);

  return {
    room: nm,
    total,
    homeValue: round(homeValue),
    remoteValue: round(remoteValue),
    mineralBonus,
    mineral: home.mineral?.t || null,
    enemyNeighbours,
    homeSources: homeSrc.map((s) => ({ x: s.x, y: s.y, dist: s.dist, value: s.value })),
    remoteSources: remotes.sort((a, b) => b.value - a.value),
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

  console.log("room      TOTAL   home   remote  mineral  enemies  | homeSrc(dist)         topRemote(dist)");
  for (const r of out) {
    if (r.error) { console.log(`${r.room.padEnd(8)}  ERROR: ${r.error}`); continue; }
    const hs = r.homeSources.map((s) => `${s.dist}`).join(",");
    const reach = r.remoteSources.filter((s) => s.reachable);
    const cut = r.remoteSources.length - reach.length;
    const tr = reach.slice(0, 4).map((s) => `${s.room}:${s.dist}`).join(" ") + (cut ? `  (+${cut} walled-off)` : "");
    console.log(
      `${r.room.padEnd(8)}  ${String(r.total).padEnd(6)}  ${String(r.homeValue).padEnd(5)}  ${String(r.remoteValue).padEnd(6)}  ${String(r.mineral || "-").padEnd(7)}  ${String(r.enemyNeighbours).padEnd(7)}  | ${hs.padEnd(20)}  ${tr}`,
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
