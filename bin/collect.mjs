#!/usr/bin/env node
// ============================================================================
//  collect.mjs — resilient background world collector.
//
//  Walks the room grid, fetches terrain + objects ONCE per room, stores into
//  the SQLite mirror (db.mjs). Designed to run long in tmux and survive:
//    - restarts: it asks the DB which rooms are missing and only fetches gaps
//    - rate limits: exponential backoff on HTTP 429 (sleep grows 2^fails,
//      capped), resets on success
//    - politeness: low concurrency + small inter-request delay
//
//  Ownership (mutable) is refreshed separately and cheaply via map-stats
//  batches — see --owners mode.
//
//  Usage:
//    SCREEPS_TOKEN=*** node bin/collect.mjs            # fill terrain/objects gaps
//    SCREEPS_TOKEN=*** node bin/collect.mjs --owners   # refresh ownership only
//    SCREEPS_TOKEN=*** node bin/collect.mjs --rescan   # re-crawl v1 rooms for v2 fields
//    flags: --range 35  --conc 2  --server URL  --shard shardSeason
//           --main   (sugar: crawl shard2 on https://screeps.com into tmp/shard2.db)
//           --center W55S43  (box the ±range crawl around home, not the origin —
//                             required on the MMO where home is far from W0/N0)
//
//  --rescan: the v2 scan captures keeper lairs, extractor, invader cores,
//  controller owner/level/reservation, mineral density, portals and highway
//  deposits/power banks that the original v1 scan dropped. Rooms scanned before
//  the schema bump have those columns NULL; --rescan re-fetches every room whose
//  `scan_v` is below the current SCAN_V to backfill them (a full ±31 re-crawl is
//  ~840s — same cost as the first crawl, since it re-hits room-objects).
// ============================================================================
import { openDb, upsertRoom, upsertOwnership, parseRoom, roomName, resolveWorld, SCAN_V } from "./db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
// World selection: --main targets shard2 on the MMO root; explicit --server/--shard
// override. The resolved shard also picks the per-shard DB file (no cross-shard mix).
const MAIN = arg("main", false) === true;
const W = resolveWorld({ main: MAIN, shard: arg("shard", null), server: arg("server", null) });
const SERVER = String(W.server).replace(/\/$/, "");
const SHARD = W.shard;
const RANGE = parseInt(arg("range", "35"), 10);
// Crawl box CENTRE. Season's playable map hugs the W0/N0 origin, so the default
// box is centred there. The MMO (shard2) is a vast persistent world and our home
// (e.g. W55S43) sits far from origin — pass --center <ROOM> to box the crawl
// around home instead, so the ±range window actually covers our neighbourhood.
const CENTER = arg("center", null);
const CONC = parseInt(arg("conc", "2"), 10);
const OWNERS = arg("owners", false) === true;
const RESCAN = arg("rescan", false) === true;
const TOKEN = process.env.SCREEPS_TOKEN;
if (!TOKEN) { console.error("SCREEPS_TOKEN not set"); process.exit(1); }

let backoff = 0; // consecutive 429s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}) {
  for (;;) {
    const res = await fetch(`${SERVER}/api${path}`, {
      ...opts,
      headers: { "X-Token": TOKEN, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    });
    if (res.status === 429) {
      backoff++;
      const wait = Math.min(2000 * 2 ** backoff, 60000);
      process.stderr.write(`  429 -> backoff ${wait}ms (fails=${backoff})\n`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    if (backoff > 0) backoff = Math.max(0, backoff - 1); // ease off on success
    return res.json();
  }
}

// Enumerate the ±range room box. Centred on origin by default; --center <ROOM>
// shifts the box to box a far-from-origin home (the MMO case).
const CENTER_XY = CENTER ? parseRoom(CENTER) : { sx: 0, sy: 0 };
function gridRooms(range) {
  const out = [];
  for (let sx = -range; sx < range; sx++)
    for (let sy = -range; sy < range; sy++) out.push(roomName(CENTER_XY.sx + sx, CENTER_XY.sy + sy));
  return out;
}
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function refreshOwners(db) {
  const rooms = gridRooms(RANGE);
  let claimed = 0, scanned = 0;
  const players = new Map();
  for (const batch of chunk(rooms, 400)) {
    const r = await api("/game/map-stats", {
      method: "POST", body: JSON.stringify({ rooms: batch, shard: SHARD, statName: "owner0" }),
    });
    for (const [name, s] of Object.entries(r.stats || {})) {
      if (s.status !== "normal") continue;
      scanned++;
      const owner = s.own?.user || null;
      if (owner) { claimed++; players.set(owner, (players.get(owner) || 0) + 1); }
      const uname = owner ? r.users?.[owner]?.username || null : null;
      upsertOwnership(db, { name, owner, owner_name: uname, level: s.own?.level ?? null, respawn: !!s.respawnArea });
    }
    await sleep(500);
  }
  // persist player sizes (threat weighting input)
  for (const [id, count] of players) {
    db.prepare(`INSERT INTO players(id,room_count,seen_at) VALUES(?,?,?)
                ON CONFLICT(id) DO UPDATE SET room_count=excluded.room_count, seen_at=excluded.seen_at`)
      .run(id, count, Date.now());
  }
  console.log(`owners refreshed: ${scanned} normal rooms, ${claimed} claimed, ${players.size} players`);
}

// Parse a room-objects payload into the snake_case row that upsertRoom expects.
// Captures the full scout-relevant object set; missing object types simply
// leave their fields at the defaults (NULL/0). `users` maps user ids to names
// when the payload carries it, letting us record controller/reserver usernames
// inline without a second map-stats call.
function parseObjects(objects, users) {
  const sources = [], keeperLairs = [], portals = [];
  const row = {
    sources: 0, sources_json: null, mineral: null, mineral_xy: null,
    mineral_density: null, controller: 0, controller_xy: null,
    controller_level: null, controller_owner: null, controller_owner_name: null,
    reservation_owner: null, reservation_owner_name: null, reservation_end: null,
    safe_mode: null, keeper_lairs: 0, keeper_lairs_json: null, extractor: null,
    invader_core: null, invader_core_level: null, portal: null, portal_json: null,
    deposit: null, deposit_type: null, power_bank: null,
  };
  const uname = (id) => (id ? users?.[id]?.username ?? null : null);

  for (const o of objects || []) {
    switch (o.type) {
      case "source":
        sources.push([o.x, o.y]);
        break;
      case "mineral":
        row.mineral = o.mineralType;
        row.mineral_xy = `${o.x},${o.y}`;
        row.mineral_density = o.density ?? null;
        break;
      case "controller":
        row.controller = 1;
        row.controller_xy = `${o.x},${o.y}`;
        row.controller_level = o.level ?? 0;
        row.controller_owner = o.user ?? null;
        row.controller_owner_name = uname(o.user);
        if (o.reservation) {
          row.reservation_owner = o.reservation.user ?? null;
          row.reservation_owner_name = uname(o.reservation.user);
          row.reservation_end = o.reservation.endTime ?? null;
        }
        row.safe_mode = o.safeMode ?? null;
        break;
      case "keeperLair":
        keeperLairs.push([o.x, o.y]);
        break;
      case "extractor":
        row.extractor = 1;
        break;
      case "invaderCore":
        row.invader_core = 1;
        row.invader_core_level = o.level ?? 0;
        break;
      case "portal":
        portals.push({ x: o.x, y: o.y, dest: o.destination ?? null });
        break;
      case "deposit":
        row.deposit = 1;
        row.deposit_type = o.depositType ?? null;
        break;
      case "powerBank":
        row.power_bank = 1;
        break;
    }
  }
  row.sources = sources.length;
  row.sources_json = JSON.stringify(sources);
  row.keeper_lairs = keeperLairs.length;
  row.keeper_lairs_json = keeperLairs.length ? JSON.stringify(keeperLairs) : null;
  row.portal = portals.length ? 1 : null;
  row.portal_json = portals.length ? JSON.stringify(portals) : null;
  return row;
}

async function fetchRoom(db, name) {
  const { sx, sy } = parseRoom(name);
  const [terr, objr] = await Promise.all([
    api(`/game/room-terrain?room=${name}&shard=${SHARD}&encoded=1`),
    api(`/game/room-objects?room=${name}&shard=${SHARD}`),
  ]);
  const tstr = Array.isArray(terr.terrain) ? terr.terrain[0].terrain : terr.terrain;
  const objs = parseObjects(objr.objects, objr.users);
  upsertRoom(db, {
    name, sx, sy, status: "normal", terrain: tstr,
    scanned_at: Date.now(), scan_v: SCAN_V, ...objs,
  });
  return objs.sources;
}

async function main() {
  const db = openDb(W.dbPath);
  if (OWNERS) { await refreshOwners(db); db.close(); return; }

  const all = gridRooms(RANGE);
  // Normal mode fills gaps (rooms with no terrain). --rescan instead re-fetches
  // already-collected rooms whose scan_v is below the current schema, to
  // backfill the v2 scout fields without re-crawling untouched gaps.
  let todo, cachedNote;
  if (RESCAN) {
    const stale = db.prepare(
      `SELECT name FROM rooms WHERE terrain IS NOT NULL AND (scan_v IS NULL OR scan_v < ?)`,
    ).all(SCAN_V).map((r) => r.name);
    const inBox = new Set(all);
    todo = stale.filter((n) => inBox.has(n));
    cachedNote = `rescan: ${stale.length} rooms below scan_v ${SCAN_V}, ${todo.length} in ±${RANGE} box to re-fetch`;
  } else {
    const have = new Set(db.prepare(`SELECT name FROM rooms WHERE terrain IS NOT NULL`).all().map((r) => r.name));
    todo = all.filter((n) => !have.has(n));
    cachedNote = `collect: ${all.length} rooms in ±${RANGE} box, ${have.size} cached, ${todo.length} to fetch`;
  }
  console.log(cachedNote);

  let done = 0, t0 = Date.now();
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      try { await fetchRoom(db, name); }
      catch (e) { process.stderr.write(`  ${name} failed: ${e.message}\n`); }
      if (++done % 25 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${todo.length}  (${rate.toFixed(1)}/s, eta ${((todo.length - done) / rate / 60).toFixed(1)}min)`);
      }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`collect done: ${done} rooms in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  db.close();
}
main().catch((e) => { console.error("collect failed:", e.message); process.exit(1); });
