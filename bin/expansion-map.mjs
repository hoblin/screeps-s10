#!/usr/bin/env node
// ============================================================================
//  expansion-map.mjs — bake the bot's static neighbourhood map from the SQLite
//  mirror into a build artifact (src/data/expansionMap.json).
//
//  WHY: a neighbour room's GEOMETRY (sources, terrain, controller) and its
//  KEEPER LAIRS are static — known the moment the crawler scans them. So we bake
//  them into a JSON the bot bundles and reads at tick 0, instead of spending
//  creeps + CPU rediscovering them live. The bot then plans remote mining
//  (#18) straight from the map: which neighbour, where its sources/controller
//  are, how far the haul is, and — critically — which neighbours are LETHAL.
//
//  The map is a PRIOR. It carries only stable facts; VOLATILE danger (live
//  hostile creeps, who claimed a room since the scan) the bot confirms at
//  runtime before committing. So the map's job is target RANKING + a hard
//  danger filter, not a live safety guarantee.
//
//  Remote mining is ORTHOGONAL-only: a creep crosses one shared border per hop,
//  and diagonal neighbours need two hops — not worth remoting early. So the map
//  covers the 4 orthogonal neighbours (the region-score model's remote set),
//  not the full 8-room ring.
//
//  DB-only — zero API access (the crawler, bin/collect.mjs, is the sole API
//  owner). Run the crawler first; un-scanned neighbours are simply omitted.
//
//  Usage:
//    node bin/expansion-map.mjs --room E15S7
//    node bin/expansion-map.mjs --room W55S43 --out src/data/expansionMap.json
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, loadRoom, parseRoom, resolveWorld } from "./db.mjs";
import { distField, crossBorderDist, valueOf, orthoNeighbours, BASE_REMOTE } from "./region-score.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag (e.g. --main)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const HOME = arg("room", null);
const OUT = arg("out", "src/data/expansionMap.json");
// --main reads the shard2 mirror (tmp/shard2.db); default = Season. The shard is a
// map label AND picks the DB file — no API access (the crawler owns that).
const W = resolveWorld({ main: arg("main", false) === true, shard: arg("shard", null) });
const SHARD = W.shard; // baked into each home entry as a label
const round = (n) => (isFinite(n) ? Math.round(n * 10) / 10 : null);

// Build the neighbourhood map for one home room. Returns the per-home entry:
//   { generatedAt, shard, home, remotes:[...safe, ranked], avoid:[...danger] }
function buildMap(db, home) {
  const homeRoom = loadRoom(db, home);
  if (!homeRoom) throw new Error(`${home} not collected (run bin/collect.mjs)`);
  if (!homeRoom.controller) throw new Error(`${home} has no controller — not a home room`);

  // Haul cost is measured from the controller tile (a stable spawn proxy, same
  // as region-score), terrain-weighted, reused from the economic model.
  const homeField = distField(homeRoom.g, homeRoom.controller.x, homeRoom.controller.y);

  const remotes = [];
  const avoid = [];
  // Every neighbour we can't remote-mine, recorded with WHY — no silent drops, so
  // the map is a full audit of all four orthogonal neighbours (#95).
  const excluded = [];
  for (const { dir, room } of orthoNeighbours(home)) {
    const nb = loadRoom(db, room);
    if (!nb) { excluded.push({ room, dir, reason: "notScanned" }); continue; }

    // ---- danger filter: never let raw economy outvote lethality ------------
    // A Source-Keeper room (keeper lairs) is the classic trap — fat (3 sources)
    // but guarded by keepers we can't clear until a far-future boosted stage.
    if (nb.keeperLairs.length > 0) {
      avoid.push({ room, reason: "sourceKeeper", lairs: nb.keeperLairs.length, sources: nb.sources.length, mineral: nb.mineral?.t || null });
      continue;
    }
    if (nb.owner) {
      avoid.push({ room, reason: "enemyOwned", owner: nb.owner, level: nb.controller?.level ?? null });
      continue;
    }
    if (nb.invaderCore) {
      avoid.push({ room, reason: "invaderCore", level: nb.invaderCore.level });
      continue;
    }

    // ---- safe neutral remote: needs a controller (to reserve) and sources ---
    // (A controllerless room WITH sources is a Source-Keeper room, already caught
    // above by its lairs; a controllerless non-SK room has no sources. So these two
    // are pure audit, not a real loss of a mineable target.)
    if (!nb.controller) { excluded.push({ room, dir, reason: "noController", sources: nb.sources.length }); continue; }
    if (nb.sources.length === 0) { excluded.push({ room, dir, reason: "noSources" }); continue; }

    const sources = nb.sources
      .map((s) => {
        const d = crossBorderDist(homeRoom, homeField, nb, dir, s);
        const reachable = isFinite(d);
        return { x: s.x, y: s.y, dist: reachable ? round(d) : null, value: reachable ? round(valueOf(BASE_REMOTE, d * 2)) : 0, reachable };
      })
      .filter((s) => s.reachable); // border walled off => source unreachable from home
    if (sources.length === 0) {
      // Has a controller + sources, but every source is walled off across the
      // shared border (crossBorderDist = ∞) — looks mineable, isn't. E.g. E15S8.
      excluded.push({ room, dir, reason: "unreachable", sources: nb.sources.length });
      continue;
    }

    remotes.push({
      room,
      dir,
      controller: { x: nb.controller.x, y: nb.controller.y },
      mineral: nb.mineral?.t || null,
      reservedByOther: !!nb.reservation?.owner,
      score: round(sources.reduce((a, s) => a + s.value, 0)),
      sources,
    });
  }
  remotes.sort((a, b) => b.score - a.score);

  return { generatedAt: new Date().toISOString(), shard: SHARD, home, remotes, avoid, excluded };
}

function main() {
  if (!HOME) {
    console.error("Usage: node bin/expansion-map.mjs --room <ROOM> [--out src/data/expansionMap.json] [--shard shardSeason]");
    process.exit(1);
  }
  parseRoom(HOME); // validate the room name early (throws on a bad name)

  const db = openDb(W.dbPath);
  // Merge into any existing map (keyed by home room) so both home rooms — main
  // (W55S43) and season (E15S7) — can coexist in one bundled artifact.
  let map = {};
  try { map = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* fresh file */ }
  map[HOME] = buildMap(db, HOME);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(map, null, 2));

  const m = map[HOME];
  console.log(`Expansion map for ${HOME} (${m.shard}) -> ${OUT}\n`);
  console.log(`  remotes (safe, ranked by economic value):`);
  if (!m.remotes.length) console.log("    (none — no safe mineable orthogonal neighbour scanned)");
  for (const r of m.remotes) {
    const dists = r.sources.map((s) => s.dist).join("/");
    console.log(`    ${r.room.padEnd(8)} [${r.dir}] score ${String(r.score).padEnd(5)} ${r.sources.length} src (d ${dists}) ctrl ${r.controller.x},${r.controller.y}${r.mineral ? ` min:${r.mineral}` : ""}${r.reservedByOther ? "  ⚠RESERVED-by-other" : ""}`);
  }
  console.log(`\n  avoid (danger — never remote-mine):`);
  if (!m.avoid.length) console.log("    (none scanned)");
  for (const a of m.avoid) {
    console.log(`    ${a.room.padEnd(8)} ${a.reason}${a.owner ? ` (${a.owner})` : ""}${a.sources ? ` ${a.sources} src` : ""}${a.lairs ? ` ${a.lairs} lairs` : ""}`);
  }
  console.log(`\n  excluded (not viable — recorded for audit, no silent drops):`);
  if (!m.excluded.length) console.log("    (none)");
  for (const e of m.excluded) {
    console.log(`    ${e.room.padEnd(8)} [${e.dir}] ${e.reason}${e.sources != null ? ` ${e.sources} src` : ""}`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
