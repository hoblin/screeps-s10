// ============================================================================
//  db.mjs — local SQLite mirror of the Screeps world. Scan the API ONCE,
//  store everything here, then run any number of heat-maps / scoring models
//  offline with zero further API calls.
//
//  Tables:
//    rooms      — immutable-ish facts: terrain blob, sources, mineral,
//                 controller, coordinates. Terrain never changes all season,
//                 so once scanned a room is cached forever.
//    ownership  — mutable: who owns the room, refreshed cheaply via map-stats
//                 batches (the contested landscape changes minute to minute).
//    edges      — cached cross-border haul distances (expensive pathfinding),
//                 computed once per (room,source)->neighbour pair.
//    rooms_rtree— spatial index for fast radius/box queries when building
//                 heat maps over a region.
//
//  Coordinates: sx,sy signed integer grid. west = negative x, east = positive;
//  north = positive y, south = negative. Matches the room-name helpers below.
// ============================================================================
import { DatabaseSync } from "node:sqlite";

// ---- world registry --------------------------------------------------------
//  One DB file per shard — terrain & geometry are per-shard, so a Season scan and
//  a Main (shard2) scan must never share a mirror. The shard name picks the file;
//  this registry is the single source of truth for the API host + local DB file
//  backing each world. Default world stays Season (back-compat for the bare CLI).
export const WORLDS = {
  shardSeason: { server: "https://screeps.com/season", db: "season.db", tag: "season" },
  shard2:      { server: "https://screeps.com",        db: "shard2.db", tag: "shard2" },
};

// Local SQLite path for a shard. Unknown shards fall back to "<shard>.db" so a new
// shard works without a registry edit; known shards get their canonical filename.
export function dbPathForShard(shard) {
  const file = WORLDS[shard]?.db ?? `${shard}.db`;
  return new URL(`../tmp/${file}`, import.meta.url).pathname;
}

// Short filesystem-friendly label for a shard, used to prefix per-world output
// artifacts (tmp/<tag>-region.json, tmp/<tag>-heatmap.png) so a Main run never
// clobbers Season analysis. shardSeason → "season"; others → the shard name.
export function worldTag(shard) { return WORLDS[shard]?.tag ?? shard; }

// Resolve {server, shard, dbPath, tag} from CLI intent. `--main` is sugar for the
// shard2 MMO world; an explicit --shard/--server always wins over the sugar.
// Default (no flags) = Season, matching the historical behaviour.
export function resolveWorld({ main = false, shard = null, server = null } = {}) {
  const sh = shard ?? (main ? "shard2" : "shardSeason");
  const w = WORLDS[sh] ?? {};
  return {
    shard: sh,
    server: server ?? w.server ?? "https://screeps.com",
    dbPath: dbPathForShard(sh),
    tag: worldTag(sh),
  };
}

export const DB_PATH = dbPathForShard("shardSeason");

// Current room-scan schema version. Bump when fetchRoom starts capturing new
// object fields; rooms with a lower `scan_v` (or NULL, the pre-versioned v1
// scan) lack those columns and must be re-crawled (`collect.mjs --rescan`).
export const SCAN_V = 2;

// v2 columns — richer scout data added on top of the original v1 room facts.
// All nullable so a v1 DB upgrades in place: ALTER ADD COLUMN backfills NULLs,
// and analytics treats NULL as "unknown / not rescanned" rather than "absent".
const V2_COLUMNS = [
  ["keeper_lairs",          "INTEGER"], // count of Source-Keeper lairs (>0 => SK room)
  ["keeper_lairs_json",     "TEXT"],    // [[x,y],...]
  ["extractor",             "INTEGER"], // 1 if a mineral extractor is built
  ["invader_core",          "INTEGER"], // 1 if an NPC invader core is present
  ["invader_core_level",    "INTEGER"], // stronghold level 0..5
  ["controller_level",      "INTEGER"], // RCL 0..8 (0 = unowned)
  ["controller_owner",      "TEXT"],    // owner user id (username via ownership)
  ["controller_owner_name", "TEXT"],    // owner username if the objects payload carried it
  ["reservation_owner",     "TEXT"],    // reserver user id, or NULL
  ["reservation_owner_name","TEXT"],    // reserver username if known
  ["reservation_end",       "INTEGER"], // reservation end tick
  ["safe_mode",             "INTEGER"], // safeMode end tick (0/NULL = inactive)
  ["mineral_density",       "INTEGER"], // 1..4
  ["portal",                "INTEGER"], // 1 if a portal is present
  ["portal_json",           "TEXT"],    // [{x,y,dest}]
  ["deposit",               "INTEGER"], // 1 if a highway deposit is present
  ["deposit_type",          "TEXT"],    // mist|biomass|metal|silicon
  ["power_bank",            "INTEGER"], // 1 if a power bank is present
  ["scan_v",                "INTEGER"], // scan schema version (see SCAN_V)
];

// Ordered column list backing the data-driven upsert. fetchRoom produces an
// object whose keys match these column names exactly, so writes stay a flat
// map with no per-column plumbing as the schema grows.
const ROOM_COLUMNS = [
  "name", "sx", "sy", "status", "sources", "sources_json", "mineral",
  "mineral_xy", "controller", "controller_xy", "terrain", "scanned_at",
  ...V2_COLUMNS.map(([c]) => c),
];

export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      name        TEXT PRIMARY KEY,
      sx          INTEGER NOT NULL,
      sy          INTEGER NOT NULL,
      status      TEXT,
      sources     INTEGER DEFAULT 0,
      sources_json TEXT,           -- [[x,y],...]
      mineral     TEXT,            -- mineral type or NULL
      mineral_xy  TEXT,            -- "x,y" or NULL
      controller  INTEGER DEFAULT 0, -- 1 if claimable
      controller_xy TEXT,
      terrain     TEXT,            -- 2500-char encoded blob (standard row-major y*50+x)
      scanned_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_xy ON rooms(sx, sy);

    CREATE TABLE IF NOT EXISTS ownership (
      name      TEXT PRIMARY KEY,
      owner     TEXT,              -- user id or NULL
      owner_name TEXT,
      level     INTEGER,           -- controller level if known
      respawn   INTEGER,           -- LEGACY: old boolean (mere presence of a respawnArea
                                   -- field — true even for zones expired years ago on the
                                   -- MMO). Superseded by respawn_end; kept for back-compat.
      novice_end   INTEGER,        -- epoch ms when NOVICE protection ends (NULL = never had one).
                                   -- ACTIVE iff > now: veterans are locked out until then.
      respawn_end  INTEGER,        -- epoch ms when RESPAWN-area protection ends (NULL = none).
                                   -- ACTIVE iff > now. These are absolute deadlines, not booleans:
                                   -- on the persistent MMO they span years, so "is it active" is a
                                   -- live comparison to now, computed at analysis time — never frozen.
      seen_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS edges (
      from_room TEXT, src_x INTEGER, src_y INTEGER,
      to_room   TEXT, dist  REAL,
      PRIMARY KEY (from_room, src_x, src_y, to_room)
    );

    CREATE TABLE IF NOT EXISTS players (
      id        TEXT PRIMARY KEY,
      username  TEXT,
      room_count INTEGER DEFAULT 0,
      seen_at   INTEGER
    );
  `);
  // R-tree (best-effort; index only, queries fall back to idx_rooms_xy)
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS rooms_rtree USING rtree(
      id, minX, maxX, minY, maxY );`);
  } catch { /* rtree unavailable -> rely on idx_rooms_xy */ }
  migrateRooms(db);
  migrateOwnership(db);
  return db;
}

// Add any missing v2 columns to an existing rooms table. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we diff against PRAGMA table_info and ALTER in
// the gaps. Idempotent: a v2 DB is a no-op, a v1 DB gains NULL-filled columns.
function migrateRooms(db) {
  const have = new Set(db.prepare(`PRAGMA table_info(rooms)`).all().map((c) => c.name));
  for (const [col, type] of V2_COLUMNS)
    if (!have.has(col)) db.exec(`ALTER TABLE rooms ADD COLUMN ${col} ${type}`);
}

// Backfill the novice/respawn-area deadline columns onto an ownership table that
// predates them (same ADD-COLUMN-IF-MISSING pattern as migrateRooms). NULL means
// "not re-swept since the schema bump"; the next `collect.mjs --owners` fills them.
function migrateOwnership(db) {
  const have = new Set(db.prepare(`PRAGMA table_info(ownership)`).all().map((c) => c.name));
  for (const [col, type] of [["novice_end", "INTEGER"], ["respawn_end", "INTEGER"]])
    if (!have.has(col)) db.exec(`ALTER TABLE ownership ADD COLUMN ${col} ${type}`);
}

// Is a protection deadline (epoch ms) currently active? A zone protects a room only
// while its end time is still in the future. `now` is injected so analysis is
// reproducible and the same scan reads correctly whenever it's queried.
export function zoneActive(endMs, now = Date.now()) {
  return endMs != null && endMs > now;
}

// ---- terrain ---------------------------------------------------------------
//  Single source of truth for decoding the stored terrain blob. Standard Screeps
//  row-major layout: the i-th char maps to tile (x = i%50, y = i/50), i.e.
//  index = y*50 + x. Each char is '0'..'3' (bit0 = wall, bit1 = swamp).
//  region-score and any heat-map consumer MUST reuse this — never re-derive.
export function parseTerrain(str) {
  const g = new Uint8Array(2500);
  for (let i = 0; i < 2500; i++) g[i] = str.charCodeAt(i) - 48;
  return g;
}

// ---- offline room loader ---------------------------------------------------
//  Returns a decoded room read purely from the SQLite mirror. Returns null if
//  the room is not yet collected (no terrain row) so callers can fall back to
//  the API. The v2 fields are NULL for rooms scanned before the schema bump
//  (or never rescanned) — callers treat NULL/undefined as "unknown".
//
//    { g, sources:[{x,y}], controller:{x,y,level,owner}|null,
//      mineral:{x,y,t,density}|null, owner,
//      keeperLairs:[{x,y}], extractor, invaderCore:{level}|null,
//      reservation:{owner,end}|null, safeMode, portals:[{x,y,dest}],
//      deposit:{type}|null, powerBank, noviceEnd, respawnEnd, scanV }
//    noviceEnd/respawnEnd are epoch-ms protection deadlines (NULL = none); use
//    zoneActive() to test whether the protection is still in force right now.
//
export function loadRoom(db, name) {
  const row = db.prepare(`
    SELECT sources_json, mineral, mineral_xy, mineral_density,
           controller, controller_xy, controller_level, controller_owner,
           controller_owner_name, reservation_owner, reservation_owner_name,
           reservation_end, safe_mode, keeper_lairs, keeper_lairs_json,
           extractor, invader_core, invader_core_level, portal, portal_json,
           deposit, deposit_type, power_bank, scan_v, terrain
      FROM rooms WHERE name = ? AND terrain IS NOT NULL
  `).get(name);
  if (!row) return null;

  const g = parseTerrain(row.terrain);
  const sources = JSON.parse(row.sources_json || "[]").map(([x, y]) => ({ x, y }));

  let controller = null;
  if (row.controller && row.controller_xy) {
    const [x, y] = row.controller_xy.split(",").map(Number);
    controller = { x, y, level: row.controller_level ?? null, owner: row.controller_owner ?? null };
  }
  let mineral = null;
  if (row.mineral && row.mineral_xy) {
    const [x, y] = row.mineral_xy.split(",").map(Number);
    mineral = { x, y, t: row.mineral, density: row.mineral_density ?? null };
  }
  const keeperLairs = JSON.parse(row.keeper_lairs_json || "[]").map(([x, y]) => ({ x, y }));
  const reservation = row.reservation_owner
    ? { owner: row.reservation_owner, name: row.reservation_owner_name ?? null, end: row.reservation_end ?? null }
    : null;
  const invaderCore = row.invader_core ? { level: row.invader_core_level ?? 0 } : null;
  const portals = JSON.parse(row.portal_json || "[]");
  const deposit = row.deposit ? { type: row.deposit_type ?? null } : null;

  // ownership is mutable and refreshed separately; absent until --owners runs.
  // The room-objects scan also captures the controller owner inline; prefer the
  // ownership table (fresher) but fall back to the scanned controller owner.
  // novice_end/respawn_end are the protection deadlines (epoch ms); pass them up
  // raw so analysis decides "active" against the current time, not the scan time.
  const own = db.prepare(`SELECT owner, novice_end, respawn_end FROM ownership WHERE name = ?`).get(name);
  const owner = own?.owner ?? row.controller_owner ?? null;

  return {
    g, sources, controller, mineral, owner,
    keeperLairs,
    extractor: !!row.extractor,
    invaderCore,
    reservation,
    safeMode: row.safe_mode ?? null,
    portals,
    deposit,
    powerBank: !!row.power_bank,
    noviceEnd: own?.novice_end ?? null,
    respawnEnd: own?.respawn_end ?? null,
    scanV: row.scan_v ?? 1,
  };
}

// ---- room name <-> signed coords ------------------------------------------
export function parseRoom(name) {
  const m = name.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!m) throw new Error(`bad room name: ${name}`);
  const sx = m[1] === "W" ? -parseInt(m[2], 10) - 1 : parseInt(m[2], 10);
  const sy = m[3] === "N" ? parseInt(m[4], 10) + 1 : -parseInt(m[4], 10);
  return { sx, sy };
}
export function roomName(sx, sy) {
  const ew = sx < 0 ? `W${-sx - 1}` : `E${sx}`;
  const ns = sy > 0 ? `N${sy - 1}` : `S${-sy}`;
  return `${ew}${ns}`;
}

// Data-driven upsert over ROOM_COLUMNS: fetchRoom hands us an object keyed by
// column name, so adding scout fields means extending V2_COLUMNS only — the
// SQL and value mapping follow automatically. ON CONFLICT updates every column
// except the primary key; normal collection never re-touches a scanned room
// (it only fetches gaps), so a v2 scan can't be clobbered by a stale v1 row.
const UPSERT_SQL = `INSERT INTO rooms (${ROOM_COLUMNS.join(",")})
  VALUES (${ROOM_COLUMNS.map(() => "?").join(",")})
  ON CONFLICT(name) DO UPDATE SET
    ${ROOM_COLUMNS.filter((c) => c !== "name").map((c) => `${c}=excluded.${c}`).join(", ")}`;

export function upsertRoom(db, r) {
  const row = { ...r };
  row.controller = r.controller ? 1 : 0; // store claimable-ness as 0/1
  row.scanned_at ??= Date.now();
  db.prepare(UPSERT_SQL).run(...ROOM_COLUMNS.map((c) => row[c] ?? null));
  // keep rtree in sync (point room => 1x1 box at sx,sy)
  try {
    const id = rtreeId(r.sx, r.sy);
    db.prepare(`INSERT OR REPLACE INTO rooms_rtree(id,minX,maxX,minY,maxY)
                VALUES (?,?,?,?,?)`).run(id, r.sx, r.sx, r.sy, r.sy);
  } catch { /* no rtree */ }
}

export function upsertOwnership(db, o) {
  db.prepare(`
    INSERT INTO ownership (name,owner,owner_name,level,novice_end,respawn_end,seen_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      owner=excluded.owner, owner_name=excluded.owner_name, level=excluded.level,
      novice_end=excluded.novice_end, respawn_end=excluded.respawn_end, seen_at=excluded.seen_at
  `).run(o.name, o.owner ?? null, o.owner_name ?? null, o.level ?? null,
         o.noviceEnd ?? null, o.respawnEnd ?? null, o.seen_at ?? Date.now());
}

// stable positive id for an rtree point from signed coords
function rtreeId(sx, sy) { return (sx + 128) * 1000 + (sy + 128); }

export function nowSec() { return Math.floor(Date.now() / 1000); }
