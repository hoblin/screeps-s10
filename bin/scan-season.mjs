#!/usr/bin/env node
// ============================================================================
//  scan-season.mjs — survey a Screeps world/shard and rank regions for a
//  spawn (respawn) decision. Built for Season 10 (shardSeason) but works on
//  any shard/server.
//
//  Two-phase scan to stay polite to the API:
//    Phase 1 (cheap):  game/map-stats in batches  -> status + respawnArea + owner
//    Phase 2 (heavier): game/room-objects per room -> sources / mineral / controller
//
//  Region score = a candidate's own room + its 8 neighbours, because a colony
//  lives off its own 2-3 sources PLUS remote-mining adjacent rooms. We reward
//  claimable own room with many sources, lots of nearby source energy, a
//  mineral, and distance from already-owned enemy rooms.
//
//  Output: ranked table + a JSON array dumped to tmp/season-scan.json
//
//  Usage:
//    SCREEPS_TOKEN=... node bin/scan-season.mjs \
//        [--server https://screeps.com/season] [--shard shardSeason] \
//        [--range 30] [--top 15] [--concurrency 6] [--out tmp/season-scan.json]
//
//  Coordinates: room names like W12N7 / E3S20. World is a grid; we scan a box
//  of +/- range in each of the four quadrants around the W0/N0 origin corner.
// ============================================================================
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWorld } from "./db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag (e.g. --main)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// --main targets shard2 on the MMO root; explicit --server/--shard override. Default = Season.
const W = resolveWorld({ main: arg("main", false) === true, shard: arg("shard", null), server: arg("server", null) });
const SERVER = W.server;
const SHARD = W.shard;
const RANGE = parseInt(arg("range", "30"), 10); // half-width of scan box per quadrant
const TOP = parseInt(arg("top", "15"), 10);
const CONC = parseInt(arg("concurrency", "6"), 10);
const OUT = arg("out", `tmp/${W.tag}-scan.json`);
const TOKEN = process.env.SCREEPS_TOKEN;

if (!TOKEN) {
  console.error("ERROR: SCREEPS_TOKEN env var is not set");
  process.exit(1);
}

const base = SERVER.replace(/\/$/, "");
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      "X-Token": TOKEN,
      "X-Username": TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// ---- room name <-> coordinate helpers -------------------------------------
// W{x}N{y} = west/north, E{x}S{y} = east/south. We enumerate a signed grid
// where west = negative X, east = positive X; north = positive Y, south = neg.
function roomName(sx, sy) {
  const ew = sx < 0 ? `W${-sx - 1}` : `E${sx}`;
  const ns = sy > 0 ? `N${sy - 1}` : `S${-sy}`;
  return `${ew}${ns}`;
}
// Build the full scan list across the four quadrants around the origin corner.
function buildRooms(range) {
  const rooms = [];
  for (let sx = -range; sx < range; sx++) {
    for (let sy = -range; sy < range; sy++) {
      rooms.push(roomName(sx, sy));
    }
  }
  return rooms;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// neighbour room names (orthogonal + diagonal) given a room name
function neighbours(name) {
  const m = name.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!m) return [];
  const sx = m[1] === "W" ? -parseInt(m[2], 10) - 1 : parseInt(m[2], 10);
  const sy = m[3] === "N" ? parseInt(m[4], 10) + 1 : -parseInt(m[4], 10);
  const res = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      res.push(roomName(sx + dx, sy + dy));
    }
  return res;
}

async function main() {
  const t0 = Date.now();
  console.log(`Scanning ${SHARD} @ ${base}  range=±${RANGE}  (${(2 * RANGE) ** 2} rooms)`);

  // -------- Phase 1: map-stats, batched -----------------------------------
  const allRooms = buildRooms(RANGE);
  const stat = {}; // name -> { status, respawnArea, owner }
  for (const batch of chunk(allRooms, 400)) {
    const r = await api("/game/map-stats", {
      method: "POST",
      body: { rooms: batch, shard: SHARD, statName: "owner0" },
    });
    for (const [name, s] of Object.entries(r.stats || {})) {
      stat[name] = {
        status: s.status,
        respawn: !!s.respawnArea,
        owner: s.own?.user || null,
      };
    }
  }
  const live = Object.entries(stat).filter(([, s]) => s.status === "normal");
  console.log(`Phase 1: ${live.length} 'normal' rooms (of ${allRooms.length} scanned)`);

  // -------- Phase 2: room-objects per live room ---------------------------
  const rooms = {}; // name -> { sources, mineral, mineralType, controller, respawn, owner }
  const queue = live.map(([name]) => name);
  let done = 0;
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      try {
        const r = await api(`/game/room-objects?room=${name}&shard=${SHARD}`);
        const objs = r.objects || [];
        let sources = 0,
          mineral = null,
          controller = false;
        for (const o of objs) {
          if (o.type === "source") sources++;
          else if (o.type === "mineral") mineral = o.mineralType || true;
          else if (o.type === "controller") controller = true;
        }
        rooms[name] = {
          sources,
          mineral: mineral || null,
          controller,
          respawn: stat[name].respawn,
          owner: stat[name].owner,
        };
      } catch (e) {
        rooms[name] = { error: String(e.message || e) };
      }
      if (++done % 50 === 0) console.log(`  Phase 2: ${done}/${live.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`Phase 2: fetched ${Object.keys(rooms).length} rooms`);

  // -------- Scoring --------------------------------------------------------
  // A spawn room must be claimable (has controller), unowned, respawn-legal.
  // Region value = own sources*3 (you mine these full-time) + neighbour
  // sources*1 (remote-mineable) + mineral bonus + isolation bonus.
  const candidates = [];
  for (const [name, r] of Object.entries(rooms)) {
    if (r.error || !r.controller || r.owner) continue;
    const nb = neighbours(name);
    let nbSources = 0,
      nbEnemies = 0,
      nbHighway = 0;
    for (const n of nb) {
      const nr = rooms[n];
      if (!nr) continue; // outside scan / unknown
      if (nr.owner) nbEnemies++;
      if (nr.controller === false && nr.sources === 0) nbHighway++;
      nbSources += nr.sources || 0;
    }
    const score =
      r.sources * 3 +
      nbSources * 1 +
      (r.mineral ? 2 : 0) -
      nbEnemies * 5 + // hostile neighbour is dangerous
      nbHighway * 0.5; // highway access = trade/scout corridor, mild plus
    candidates.push({
      room: name,
      score: Math.round(score * 10) / 10,
      ownSources: r.sources,
      mineral: r.mineral,
      nbSources,
      nbEnemies,
      respawn: r.respawn,
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  // -------- Output ---------------------------------------------------------
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ shard: SHARD, scannedAt: new Date().toISOString(), candidates }, null, 2));

  console.log(`\nTop ${TOP} spawn candidates (region = room + 8 neighbours):`);
  console.log("rank  room      score  ownSrc  nbSrc  mineral  enemies  respawn");
  candidates.slice(0, TOP).forEach((c, i) => {
    console.log(
      `${String(i + 1).padEnd(4)}  ${c.room.padEnd(8)}  ${String(c.score).padEnd(5)}  ${String(c.ownSources).padEnd(6)}  ${String(c.nbSources).padEnd(5)}  ${String(c.mineral || "-").padEnd(7)}  ${String(c.nbEnemies).padEnd(7)}  ${c.respawn}`,
    );
  });
  console.log(`\nFull array -> ${OUT}  (${candidates.length} claimable candidates)`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("scan failed:", e.message || e);
  process.exit(1);
});
