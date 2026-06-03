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

export const DB_PATH = new URL("../tmp/season.db", import.meta.url).pathname;

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
      terrain     TEXT,            -- 2500-char encoded blob (transposed x*50+y)
      scanned_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_xy ON rooms(sx, sy);

    CREATE TABLE IF NOT EXISTS ownership (
      name      TEXT PRIMARY KEY,
      owner     TEXT,              -- user id or NULL
      owner_name TEXT,
      level     INTEGER,           -- controller level if known
      respawn   INTEGER,           -- 1 if still respawn-eligible
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
  return db;
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

export function upsertRoom(db, r) {
  db.prepare(`
    INSERT INTO rooms (name,sx,sy,status,sources,sources_json,mineral,mineral_xy,
                       controller,controller_xy,terrain,scanned_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      status=excluded.status, sources=excluded.sources,
      sources_json=excluded.sources_json, mineral=excluded.mineral,
      mineral_xy=excluded.mineral_xy, controller=excluded.controller,
      controller_xy=excluded.controller_xy, terrain=excluded.terrain,
      scanned_at=excluded.scanned_at
  `).run(
    r.name, r.sx, r.sy, r.status ?? null, r.sources ?? 0,
    r.sources_json ?? null, r.mineral ?? null, r.mineral_xy ?? null,
    r.controller ? 1 : 0, r.controller_xy ?? null, r.terrain ?? null,
    r.scanned_at ?? Date.now(),
  );
  // keep rtree in sync (point room => 1x1 box at sx,sy)
  try {
    const id = rtreeId(r.sx, r.sy);
    db.prepare(`INSERT OR REPLACE INTO rooms_rtree(id,minX,maxX,minY,maxY)
                VALUES (?,?,?,?,?)`).run(id, r.sx, r.sx, r.sy, r.sy);
  } catch { /* no rtree */ }
}

export function upsertOwnership(db, o) {
  db.prepare(`
    INSERT INTO ownership (name,owner,owner_name,level,respawn,seen_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      owner=excluded.owner, owner_name=excluded.owner_name,
      level=excluded.level, respawn=excluded.respawn, seen_at=excluded.seen_at
  `).run(o.name, o.owner ?? null, o.owner_name ?? null,
         o.level ?? null, o.respawn ? 1 : 0, o.seen_at ?? Date.now());
}

// stable positive id for an rtree point from signed coords
function rtreeId(sx, sy) { return (sx + 128) * 1000 + (sy + 128); }

export function nowSec() { return Math.floor(Date.now() / 1000); }
