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
//    flags: --range 35  --conc 2  --server URL  --shard shardSeason
// ============================================================================
import { openDb, upsertRoom, upsertOwnership, parseRoom, roomName } from "./db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SERVER = String(arg("server", "https://screeps.com/season")).replace(/\/$/, "");
const SHARD = String(arg("shard", "shardSeason"));
const RANGE = parseInt(arg("range", "35"), 10);
const CONC = parseInt(arg("conc", "2"), 10);
const OWNERS = arg("owners", false) === true;
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

function gridRooms(range) {
  const out = [];
  for (let sx = -range; sx < range; sx++)
    for (let sy = -range; sy < range; sy++) out.push(roomName(sx, sy));
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

async function fetchRoom(db, name) {
  const { sx, sy } = parseRoom(name);
  const [terr, objr] = await Promise.all([
    api(`/game/room-terrain?room=${name}&shard=${SHARD}&encoded=1`),
    api(`/game/room-objects?room=${name}&shard=${SHARD}`),
  ]);
  const tstr = Array.isArray(terr.terrain) ? terr.terrain[0].terrain : terr.terrain;
  const sources = [];
  let mineral = null, mineral_xy = null, controller = 0, controller_xy = null, status = "normal";
  for (const o of objr.objects || []) {
    if (o.type === "source") sources.push([o.x, o.y]);
    else if (o.type === "mineral") { mineral = o.mineralType; mineral_xy = `${o.x},${o.y}`; }
    else if (o.type === "controller") { controller = 1; controller_xy = `${o.x},${o.y}`; }
  }
  upsertRoom(db, {
    name, sx, sy, status, sources: sources.length,
    sources_json: JSON.stringify(sources), mineral, mineral_xy,
    controller, controller_xy, terrain: tstr, scanned_at: Date.now(),
  });
  return sources.length;
}

async function main() {
  const db = openDb();
  if (OWNERS) { await refreshOwners(db); db.close(); return; }

  const all = gridRooms(RANGE);
  const have = new Set(db.prepare(`SELECT name FROM rooms WHERE terrain IS NOT NULL`).all().map((r) => r.name));
  const todo = all.filter((n) => !have.has(n));
  console.log(`collect: ${all.length} rooms in ±${RANGE} box, ${have.size} cached, ${todo.length} to fetch`);

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
