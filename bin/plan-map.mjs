#!/usr/bin/env node
// ============================================================================
//  plan-map.mjs — OFFLINE verifier for the unified RoomPlanner core (#258).
//  AGENT DEV TOOL, not bundled into the bot and not a product feature.
//
//  Runs the REAL layout core (src/lib/roomLayout.js — the same pure function the
//  live RoomPlanner calls) over a room's terrain + sources/controller/mineral from
//  the SQLite mirror, then renders a 50×50 TILE PNG so the layout can be eyeballed
//  on real season rooms WITHOUT deploying. Also prints per-type counts and a
//  hard collision check (no two structures on a tile, no road on a structure).
//
//  Usage:
//    node bin/plan-map.mjs E15S7                 # expansion mode (anchor computed)
//    node bin/plan-map.mjs E15S7 --anchor 25,28  # pin a home spawn as the anchor
//    flags: --main (shard2 mirror)  --shard <name>  --out <path>  --scale <px/tile>
// ============================================================================
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, resolveWorld, loadRoom } from "./db.mjs";
import { encodePng } from "./png.mjs";
import { computeLayout, S } from "../src/lib/roomLayout.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--"))) return true;
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const room = process.argv.slice(2).find((a) => /^[EW]\d+[NS]\d+$/.test(a));
if (!room) {
  console.error("usage: node bin/plan-map.mjs <ROOM> [--anchor x,y] [--main] [--out path] [--scale n]");
  process.exit(1);
}
const W = resolveWorld({ main: arg("main", false) === true, shard: arg("shard", null) });
const OUT = String(arg("out", `tmp/${room}-plan.png`));
const SCALE = parseInt(String(arg("scale", "10")), 10);
const anchorArg = arg("anchor", null);
const anchor = anchorArg && anchorArg !== true ? { x: +anchorArg.split(",")[0], y: +anchorArg.split(",")[1] } : null;

// A literal mirror of CONTROLLER_STRUCTURES (the live core reads the game global;
// offline we carry the same fixed schedule so the per-RCL counts match exactly).
const CAPS = {
  [S.SPAWN]: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
  [S.EXTENSION]: { 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
  [S.TOWER]: { 3: 1, 5: 2, 7: 3, 8: 6 },
  [S.STORAGE]: { 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
  [S.LINK]: { 5: 2, 6: 3, 7: 4, 8: 6 },
  [S.TERMINAL]: { 6: 1, 7: 1, 8: 1 },
  [S.LAB]: { 6: 3, 7: 6, 8: 10 },
  [S.FACTORY]: { 7: 1, 8: 1 },
  [S.POWER_SPAWN]: { 8: 1 },
  [S.NUKER]: { 8: 1 },
  [S.OBSERVER]: { 8: 1 },
};

// ---- load the room from the mirror -----------------------------------------
const db = openDb(W.dbPath);
const r = loadRoom(db, room);
if (!r) {
  console.error(`${room} not in the ${W.tag} mirror (run the crawler first)`);
  process.exit(1);
}
const g = r.g;
const terrain = (x, y) => (x < 0 || y < 0 || x >= 50 || y >= 50 ? 1 : g[y * 50 + x]);

const plan = computeLayout({
  terrain,
  sources: r.sources,
  controller: r.controller,
  mineral: r.mineral,
  anchor,
  controllerStructures: CAPS,
});

// ---- collision self-check ---------------------------------------------------
const structKeyToType = new Map();
let collisions = 0;
for (const type in plan.structures) {
  for (const s of plan.structures[type]) {
    const k = `${s.x},${s.y}`;
    if (structKeyToType.has(k)) {
      console.error(`COLLISION: ${type} and ${structKeyToType.get(k)} both at ${k}`);
      collisions++;
    } else structKeyToType.set(k, type);
  }
}
let roadOnStruct = 0;
for (const road of plan.roads) {
  if (structKeyToType.has(`${road.x},${road.y}`)) {
    console.error(`ROAD-ON-STRUCTURE: road at ${road.x},${road.y} over ${structKeyToType.get(`${road.x},${road.y}`)}`);
    roadOnStruct++;
  }
}

// ---- render -----------------------------------------------------------------
// terrain background + per-structure colours; sources/controller/mineral as bright
// markers so the layout reads against what it serves.
const BG_PLAIN = [40, 40, 46];
const BG_SWAMP = [44, 58, 44];
const BG_WALL = [16, 16, 20];
const ROAD = [90, 90, 96];
const COLOR = {
  [S.SPAWN]: [255, 230, 90],
  [S.EXTENSION]: [250, 180, 60],
  [S.TOWER]: [235, 80, 70],
  [S.STORAGE]: [80, 200, 255],
  [S.LINK]: [200, 110, 255],
  [S.CONTAINER]: [120, 220, 150],
  [S.TERMINAL]: [120, 160, 255],
  [S.EXTRACTOR]: [220, 220, 220],
  [S.LAB]: [255, 130, 200],
  [S.FACTORY]: [180, 140, 100],
  [S.POWER_SPAWN]: [255, 100, 140],
  [S.NUKER]: [255, 60, 60],
  [S.OBSERVER]: [150, 255, 220],
};
const MARK_SOURCE = [255, 240, 0];
const MARK_CTRL = [0, 255, 120];
const MARK_MIN = [255, 255, 255];

const IMG = 50 * SCALE;
const img = Buffer.alloc(IMG * IMG * 3);
const put = (px, py, rgb) => {
  if (px < 0 || py < 0 || px >= IMG || py >= IMG) return;
  const o = (py * IMG + px) * 3;
  img[o] = rgb[0];
  img[o + 1] = rgb[1];
  img[o + 2] = rgb[2];
};
const fillTile = (x, y, rgb, inset = 0) => {
  for (let dy = inset; dy < SCALE - inset; dy++)
    for (let dx = inset; dx < SCALE - inset; dx++) put(x * SCALE + dx, y * SCALE + dy, rgb);
};
const outline = (x, y, rgb) => {
  for (let d = 0; d < SCALE; d++) {
    put(x * SCALE + d, y * SCALE, rgb);
    put(x * SCALE + d, y * SCALE + SCALE - 1, rgb);
    put(x * SCALE, y * SCALE + d, rgb);
    put(x * SCALE + SCALE - 1, y * SCALE + d, rgb);
  }
};

// 1. terrain background
for (let y = 0; y < 50; y++)
  for (let x = 0; x < 50; x++) {
    const t = terrain(x, y);
    fillTile(x, y, t === 1 ? BG_WALL : t === 2 ? BG_SWAMP : BG_PLAIN);
  }
// 2. roads (under structures), inset so terrain shows as a border
for (const rd of plan.roads) fillTile(rd.x, rd.y, ROAD, Math.floor(SCALE / 3));
// 3. structures
for (const type in plan.structures)
  for (const s of plan.structures[type]) fillTile(s.x, s.y, COLOR[type] || [255, 0, 255], 1);
// 4. served-object markers (outlines, so the structure colour stays visible)
for (const s of r.sources) outline(s.x, s.y, MARK_SOURCE);
if (r.controller) outline(r.controller.x, r.controller.y, MARK_CTRL);
if (r.mineral) outline(r.mineral.x, r.mineral.y, MARK_MIN);
// 5. anchor cross-hair
outline(plan.anchor.x, plan.anchor.y, [255, 255, 255]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, encodePng(IMG, IMG, img));

// ---- report -----------------------------------------------------------------
const counts = {};
for (const type in plan.structures) counts[type] = plan.structures[type].length;
console.log(`${room} (${W.tag})  anchor ${plan.anchor.x},${plan.anchor.y}  parity ${(plan.anchor.x + plan.anchor.y) % 2}`);
console.log(`sources ${r.sources.length}  controller ${r.controller ? `${r.controller.x},${r.controller.y}` : "—"}  mineral ${r.mineral ? `${r.mineral.x},${r.mineral.y}` : "—"}`);
console.log("structures:", JSON.stringify(counts));
console.log(`roads ${plan.roads.length}`);
console.log(collisions || roadOnStruct ? `❌ ${collisions} collisions, ${roadOnStruct} road-on-structure` : "✅ no collisions, no road-on-structure");
console.log(`PNG ${IMG}x${IMG} -> ${OUT}`);
