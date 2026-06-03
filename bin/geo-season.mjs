#!/usr/bin/env node
// ============================================================================
//  geo-season.mjs — deep geometry pass for a shortlist of candidate rooms.
//
//  Phase 1/2 (scan-season.mjs) ranks rooms by source COUNT. This pass adds the
//  thing counts can't see: LAYOUT. A room with 2 sources is worthless if both
//  sit behind walls 40 tiles from the controller. We decode the terrain and
//  run real BFS pathfinding (walls block, swamp costs 5, plain costs 1) to
//  measure true logistic distances:
//
//    - source -> source  (miner spread)
//    - each source -> controller (upgrade haul cost)
//    - each source -> best spawn spot (we approximate spawn = controller-ish
//      central open tile; real planner picks later, but relative cost holds)
//    - source -> mineral (late-game)
//
//  Lower total haul distance = tighter, cheaper colony = better.
//
//  Usage:
//    SCREEPS_TOKEN=*** node bin/geo-season.mjs W24N7 W24S3 W25N23 ...
//    (or) --from tmp/season-scan.json --top 10   to read the shortlist
//
//  Output: per-room geometry report + a geoScore (lower=better haul, we invert
//  so higher=better to match scan-season). Writes tmp/season-geo.json.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SERVER = arg("server", "https://screeps.com/season").replace(/\/$/, "");
const SHARD = arg("shard", "shardSeason");
const TOKEN = process.env.SCREEPS_TOKEN;
const OUT = arg("out", "tmp/season-geo.json");

if (!TOKEN) {
  console.error("ERROR: SCREEPS_TOKEN env var is not set");
  process.exit(1);
}

// rooms either from positional args or from a scan json shortlist
let targets = process.argv.slice(2).filter((a) => /^[WE]\d+[NS]\d+$/.test(a));
const fromFile = arg("from", null);
if (fromFile) {
  const top = parseInt(arg("top", "10"), 10);
  const data = JSON.parse(readFileSync(fromFile, "utf8"));
  targets = (data.candidates || []).slice(0, top).map((c) => c.room);
}
if (targets.length === 0) {
  console.error("No target rooms. Pass room names or --from <scan.json> --top N");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`${SERVER}/api${path}`, { headers: { "X-Token": TOKEN } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

// ---- terrain grid: 50x50, char per tile. 0=plain 1=wall 2=swamp (3=both) ---
function parseTerrain(str) {
  const g = new Uint8Array(2500);
  for (let i = 0; i < 2500; i++) g[i] = str.charCodeAt(i) - 48; // '0'..'3'
  return g;
}
// NOTE: this season server returns terrain transposed (index = x*50+y),
// not the documented y*50+x. Verified against object coords (sources/controller
// land on plains only with this indexing). If a future server reverts to the
// standard layout, flip this back to y*50+x.
const idx = (x, y) => x * 50 + y;
const isWall = (g, x, y) => x < 0 || y < 0 || x > 49 || y > 49 || (g[idx(x, y)] & 1) === 1;
const cost = (g, x, y) => ((g[idx(x, y)] & 2) === 2 ? 5 : 1); // swamp 5, plain 1

// Dijkstra (terrain-weighted BFS) from a start tile -> distance field.
function distField(g, sx, sy) {
  const dist = new Float32Array(2500).fill(Infinity);
  dist[idx(sx, sy)] = 0;
  // simple binary-heap-less Dijkstra; 2500 nodes is tiny
  const pq = [[0, sx, sy]];
  while (pq.length) {
    // pop min (linear — fine at this size)
    let mi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[mi][0]) mi = i;
    const [d, x, y] = pq.splice(mi, 1)[0];
    if (d > dist[idx(x, y)]) continue;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx,
          ny = y + dy;
        if (isWall(g, nx, ny)) continue;
        const nd = d + cost(g, nx, ny);
        if (nd < dist[idx(nx, ny)]) {
          dist[idx(nx, ny)] = nd;
          pq.push([nd, nx, ny]);
        }
      }
  }
  return dist;
}

async function analyze(room) {
  const [terr, objr] = await Promise.all([
    api(`/game/room-terrain?room=${room}&shard=${SHARD}&encoded=1`),
    api(`/game/room-objects?room=${room}&shard=${SHARD}`),
  ]);
  const tstr = Array.isArray(terr.terrain) ? terr.terrain[0].terrain : terr.terrain;
  const g = parseTerrain(tstr);
  const sources = [];
  let controller = null,
    mineral = null;
  for (const o of objr.objects || []) {
    if (o.type === "source") sources.push({ x: o.x, y: o.y });
    else if (o.type === "controller") controller = { x: o.x, y: o.y };
    else if (o.type === "mineral") mineral = { x: o.x, y: o.y, t: o.mineralType };
  }
  if (!controller || sources.length === 0) return { room, error: "no controller/sources" };

  // distance from controller to every source (controller is the upgrade sink
  // and a decent proxy for colony centre before the planner runs)
  const cf = distField(g, controller.x, controller.y);
  const srcToCtrl = sources.map((s) => cf[idx(s.x, s.y)]);
  const reachable = srcToCtrl.filter((d) => isFinite(d));
  const avgCtrl = reachable.length ? reachable.reduce((a, b) => a + b, 0) / reachable.length : Infinity;
  const maxCtrl = reachable.length ? Math.max(...reachable) : Infinity;

  // source-to-source spread (first source field)
  let srcSpread = 0;
  if (sources.length > 1) {
    const sf = distField(g, sources[0].x, sources[0].y);
    srcSpread = Math.max(...sources.slice(1).map((s) => sf[idx(s.x, s.y)]).filter(isFinite));
  }
  const mineralDist = mineral ? cf[idx(mineral.x, mineral.y)] : null;

  // open-tile ratio near controller (room for spawn+extensions): 11x11 box
  let open = 0,
    tot = 0;
  for (let x = controller.x - 5; x <= controller.x + 5; x++)
    for (let y = controller.y - 5; y <= controller.y + 5; y++) {
      if (x < 0 || y < 0 || x > 49 || y > 49) continue;
      tot++;
      if (!isWall(g, x, y)) open++;
    }
  const openRatio = tot ? open / tot : 0;

  // geoScore: reward short hauls + tight sources + open build space.
  // invert distances so higher=better, normalise loosely.
  const geoScore =
    100 -
    avgCtrl * 1.5 - // average source->controller haul dominates economy
    maxCtrl * 0.5 -
    srcSpread * 0.3 +
    openRatio * 20 - // build room near controller
    (reachable.length < sources.length ? 30 : 0); // walled-off source = bad

  return {
    room,
    sources: sources.length,
    reachableSources: reachable.length,
    avgSrcToController: round(avgCtrl),
    maxSrcToController: round(maxCtrl),
    sourceSpread: round(srcSpread),
    mineralDist: mineralDist == null ? null : round(mineralDist),
    mineral: mineral?.t || null,
    openRatioNearController: round(openRatio, 2),
    geoScore: round(geoScore),
  };
}
const round = (n, p = 1) => (isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);

async function main() {
  console.log(`Geometry pass on ${targets.length} rooms @ ${SHARD}\n`);
  const out = [];
  for (const room of targets) {
    try {
      out.push(await analyze(room));
    } catch (e) {
      out.push({ room, error: String(e.message || e) });
    }
  }
  out.sort((a, b) => (b.geoScore ?? -1e9) - (a.geoScore ?? -1e9));

  console.log("room      geoScore  src(reach)  avgSrc->Ctrl  maxSrc->Ctrl  spread  openNear  mineral(dist)");
  for (const r of out) {
    if (r.error) {
      console.log(`${r.room.padEnd(8)}  ERROR: ${r.error}`);
      continue;
    }
    console.log(
      `${r.room.padEnd(8)}  ${String(r.geoScore).padEnd(8)}  ${`${r.reachableSources}/${r.sources}`.padEnd(10)}  ${String(r.avgSrcToController).padEnd(12)}  ${String(r.maxSrcToController).padEnd(12)}  ${String(r.sourceSpread).padEnd(6)}  ${String(r.openRatioNearController).padEnd(8)}  ${r.mineral || "-"}(${r.mineralDist ?? "-"})`,
    );
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ shard: SHARD, at: new Date().toISOString(), rooms: out }, null, 2));
  console.log(`\nFull -> ${OUT}`);
}
main().catch((e) => {
  console.error("geo failed:", e.message || e);
  process.exit(1);
});
