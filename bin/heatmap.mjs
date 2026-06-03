#!/usr/bin/env node
// ============================================================================
//  heatmap.mjs — render the whole collected region as a spawn-candidate heat
//  map, straight from the SQLite mirror. Zero API calls: it reuses
//  region-score's economic model (scoreRoom) over every claimable room the
//  crawler has reached, then paints the grid.
//
//  The playable world is a 62x62 grid: W30..E00..E30 (columns, west→east) by
//  N30..N00..S30 (rows, north→south) = 3844 rooms. We render exactly that box;
//  rooms outside it, un-collected rooms, non-claimable rooms (highway/center/
//  source-keeper) and owned rooms are drawn distinctly.
//
//  Output:
//    1. an ANSI terminal grid (24-bit colour ramp by score, labelled axes)
//    2. tmp/season-heatmap.png (one pixel-block per room + legend), encoded
//       with a tiny pure-JS PNG writer (node:zlib only — no native deps)
//    3. the top-10 rooms by score, printed below the map
//
//  Usage:
//    node bin/heatmap.mjs                       # score the grid offline
//    node bin/heatmap.mjs --from tmp/season-region.json   # use precomputed scores
//    flags: --out tmp/season-heatmap.png  --no-png  --no-ansi
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { openDb } from "./db.mjs";
import { scoreRoom } from "./region-score.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")))
    return true; // boolean flag
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const FROM = arg("from", null);
const PNG_OUT = String(arg("out", "tmp/season-heatmap.png"));
const WANT_PNG = arg("no-png", false) !== true;
const WANT_ANSI = arg("no-ansi", false) !== true;

// Playable grid: signed coords. west = negative sx, north = positive sy.
const SX_MIN = -31, SX_MAX = 30; // W30 .. E30
const SY_MIN = -30, SY_MAX = 31; // S30 .. N30
const NCOL = SX_MAX - SX_MIN + 1; // 62
const NROW = SY_MAX - SY_MIN + 1; // 62

const ewLabel = (sx) => (sx < 0 ? `W${-sx - 1}` : `E${sx}`);
const nsLabel = (sy) => (sy > 0 ? `N${sy - 1}` : `S${-sy}`);
const roomAt = (sx, sy) => `${ewLabel(sx)}${nsLabel(sy)}`;

// ---- score ramp: low → high through indigo/blue/teal/green/yellow/red ------
const STOPS = [
  [13, 8, 60], [40, 60, 160], [30, 140, 140],
  [70, 180, 70], [220, 200, 40], [230, 90, 30],
];
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const s = t * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(s));
  const f = s - i, a = STOPS[i], b = STOPS[i + 1];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
}
// state colours for non-scored cells — distinct hues per category so the map
// reads at a glance (not flat grey for everything special).
const C_EMPTY = [22, 22, 28];    // not collected
const C_BLOCK = [52, 52, 60];    // collected but unclaimable & featureless
const C_OWNED = [205, 40, 175];  // owned by a player (magenta)
const C_SK = [120, 60, 170];     // Source-Keeper room (violet)
const C_HIGHWAY = [40, 110, 120]; // highway feature room: portal/deposit/power (teal)
const C_INVADER = [180, 50, 40]; // invader core (red)

// ============================================================================
//  Load scores: either a precomputed region-score JSON, or compute live.
// ============================================================================
const db = openDb();

// every room in the render box that the crawler has reached
const cells = db.prepare(`
  SELECT name, sx, sy, controller FROM rooms
   WHERE terrain IS NOT NULL
     AND sx BETWEEN ? AND ? AND sy BETWEEN ? AND ?
`).all(SX_MIN, SX_MAX, SY_MIN, SY_MAX);

const meta = new Map(); // name -> { sx, sy, claimable }
for (const c of cells) meta.set(c.name, { sx: c.sx, sy: c.sy, claimable: c.controller === 1 });

// v2 scout features per room, for glyphs + PNG markers. NULL columns (v1 rows
// not yet rescanned) simply read as 0/absent, so the map degrades gracefully.
const feat = new Map();
for (const r of db.prepare(`
  SELECT name, controller, sources, mineral, keeper_lairs, invader_core,
         invader_core_level, portal, deposit, power_bank, reservation_owner
    FROM rooms WHERE terrain IS NOT NULL
     AND sx BETWEEN ? AND ? AND sy BETWEEN ? AND ?
`).all(SX_MIN, SX_MAX, SY_MIN, SY_MAX)) {
  feat.set(r.name, r);
}

// owner -> controller level (for the enemy glyph). map-stats fills the level.
const owned = new Map();
for (const r of db.prepare(`SELECT name, level FROM ownership WHERE owner IS NOT NULL`).all()) {
  owned.set(r.name, r.level ?? 0);
}
if (owned.size === 0) {
  console.log("note: ownership table empty — all rooms render as unowned (run `collect.mjs --owners`)");
}

const score = new Map();  // name -> total
const detail = new Map(); // name -> full score result (for the enriched top-N)
const remember = (r) => {
  if (!r || r.error || r.total == null) return;
  score.set(r.room, r.total);
  detail.set(r.room, r);
};
if (FROM) {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const list = d.rooms || d.candidates || d;
  for (const r of list) remember(r);
  console.log(`loaded ${score.size} precomputed scores from ${FROM}`);
} else {
  const claimable = cells.filter((c) => c.controller === 1);
  console.log(`scoring ${claimable.length} claimable rooms offline (no API)...`);
  let done = 0;
  for (const c of claimable) {
    let r;
    try { r = await scoreRoom(c.name); } catch { /* not collected / unscorable */ }
    remember(r);
    if (++done % 200 === 0) console.log(`  ${done}/${claimable.length}`);
  }
  console.log(`scored ${score.size} rooms`);
}

// score range for the colour ramp
let lo = Infinity, hi = -Infinity;
for (const v of score.values()) { if (v < lo) lo = v; if (v > hi) hi = v; }
if (!isFinite(lo)) { lo = 0; hi = 1; }
const span = hi - lo || 1;
const norm = (v) => (v - lo) / span;

// classify a grid coordinate into [r,g,b] + a 2-char glyph encoding what's in
// the room. Every glyph is exactly 2 chars wide so columns stay aligned under
// the coloured background. Priority: ownership > SK > invader > highway feature
// > scored candidate > plain block > uncollected.
//   E<n> owned-enemy (n = RCL)   K<n> keeper room (n = sources)
//   I<n> invader core (n = level) P↔ portal   D▒ deposit   B✷ power bank
//   <n>* scored candidate (n = sources, * = has mineral)   ·· uncollected
function classify(sx, sy) {
  const nm = roomAt(sx, sy);
  const f = feat.get(nm);
  if (owned.has(nm)) return { rgb: C_OWNED, glyph: `E${lvlChar(owned.get(nm))}` };
  if (f?.keeper_lairs > 0) return { rgb: C_SK, glyph: `K${digit(f.sources)}` };
  if (f?.invader_core) return { rgb: C_INVADER, glyph: `I${digit(f.invader_core_level)}` };
  if (f?.portal) return { rgb: C_HIGHWAY, glyph: "P↔" };
  if (f?.power_bank) return { rgb: C_HIGHWAY, glyph: "B✷" };
  if (f?.deposit) return { rgb: C_HIGHWAY, glyph: "D▒" };
  if (score.has(nm)) {
    const g = `${digit(f?.sources)}${f?.mineral ? "*" : " "}`;
    return { rgb: heat(norm(score.get(nm))), glyph: g };
  }
  const m = meta.get(nm);
  if (!m) return { rgb: C_EMPTY, glyph: "··" }; // not collected
  if (!m.claimable) return { rgb: C_BLOCK, glyph: "  " }; // highway/center, no feature
  return { rgb: C_EMPTY, glyph: "··" }; // claimable but unscored (walled/edge)
}
const digit = (n) => (n > 0 && n < 10 ? String(n) : n >= 10 ? "+" : "·");
const lvlChar = (n) => (n > 0 && n <= 8 ? String(n) : "·");

// ============================================================================
//  ANSI terminal grid
// ============================================================================
function renderAnsi() {
  const MARGIN = 4; // width of the row label gutter
  // light foreground over the coloured background so the 2-char glyphs read.
  const bg = (rgb, txt) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]};38;2;235;235;235m${txt}\x1b[0m`;

  // column ruler: EW label every 5 columns, aligned to the 2-char cells
  const ruler = Array(MARGIN + NCOL * 2 + 4).fill(" ");
  for (let c = 0; c < NCOL; c++) {
    const sx = SX_MIN + c;
    if (sx % 5 === 0) {
      const lbl = ewLabel(sx), pos = MARGIN + c * 2;
      for (let k = 0; k < lbl.length; k++) ruler[pos + k] = lbl[k];
    }
  }
  const lines = [ruler.join("").replace(/\s+$/, "")];

  for (let r = 0; r < NROW; r++) {
    const sy = SY_MAX - r; // north at the top
    let row = (sy % 5 === 0 ? nsLabel(sy) : "").padEnd(MARGIN);
    for (let c = 0; c < NCOL; c++) {
      const { rgb, glyph } = classify(SX_MIN + c, sy);
      row += bg(rgb, glyph);
    }
    lines.push(row);
  }
  console.log("\n" + lines.join("\n"));
  console.log(
    `\nlegend:  score ${bg(heat(0), "  ")}${bg(heat(0.5), "  ")}${bg(heat(1), "  ")} low(${lo.toFixed(0)})→high(${hi.toFixed(0)})` +
    `   glyph ⟨n*⟩=sources(+mineral)\n` +
    `         ${bg(C_OWNED, "E7")} owned-enemy(RCL)  ${bg(C_SK, "K3")} keeper room(sources)  ${bg(C_INVADER, "I2")} invader core(lvl)\n` +
    `         ${bg(C_HIGHWAY, "P↔")} portal  ${bg(C_HIGHWAY, "D▒")} deposit  ${bg(C_HIGHWAY, "B✷")} power bank  ` +
    `${bg(C_BLOCK, "  ")} highway/center  ${bg(C_EMPTY, "··")} uncollected`,
  );
}

// ============================================================================
//  Minimal truecolour PNG encoder (node:zlib only — no native deps).
//  A PNG is an 8-byte signature followed by chunks; we emit the three
//  mandatory ones: IHDR (header), IDAT (deflated pixels), IEND (terminator).
//  Each chunk is CRC-protected, so we need the PNG/zlib CRC-32.
// ============================================================================
// CRC-32 lookup table, reflected polynomial 0xEDB88320 (the PNG/zlib variant).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// One PNG chunk: 4-byte big-endian length, 4-byte type, data, CRC32(type+data).
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function encodePng(width, height, rgb /* Buffer width*height*3 */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // raw scanlines, each prefixed with filter byte 0
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function renderPng() {
  const BLK = 10;        // pixels per room
  const LEG = 26;        // legend strip height
  const LEG_PAD = 4;     // blank padding above/below the legend gradient
  const W = NCOL * BLK;
  const H = NROW * BLK + LEG;
  const img = Buffer.alloc(W * H * 3);
  const put = (px, py, rgb) => {
    const o = (py * W + px) * 3;
    img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2];
  };
  const fillBlock = (cx, cy, rgb) => {
    for (let dy = 0; dy < BLK; dy++)
      for (let dx = 0; dx < BLK; dx++) put(cx * BLK + dx, cy * BLK + dy, rgb);
  };
  // small filled rect inside a room block (block-local coords, clipped to BLK).
  const dot = (cx, cy, ox, oy, w, h, rgb) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const px = cx * BLK + ox + dx, py = cy * BLK + oy + dy;
        if (ox + dx < BLK && oy + dy < BLK) put(px, py, rgb);
      }
  };

  // Feature markers PNG can't render as glyphs: colour-coded corner dots +
  // a source-count tick row along the bottom edge.
  const M_SK = [235, 120, 255], M_INV = [255, 70, 50], M_PORTAL = [90, 230, 235];
  const M_MIN = [235, 235, 235], M_SRC = [250, 220, 90];
  const markers = (cx, cy, nm) => {
    const f = feat.get(nm);
    if (!f) return;
    if (f.keeper_lairs > 0) dot(cx, cy, 0, 0, 3, 3, M_SK);        // top-left = SK
    if (f.invader_core) dot(cx, cy, 0, 0, 3, 3, M_INV);          // top-left = invader
    if (f.portal) dot(cx, cy, BLK - 3, 0, 3, 3, M_PORTAL);       // top-right = portal
    if (f.mineral) dot(cx, cy, BLK - 3, BLK - 3, 3, 3, M_MIN);   // bottom-right = mineral
    const n = Math.min(f.sources || 0, 3);                       // bottom edge = source count
    for (let i = 0; i < n; i++) dot(cx, cy, 1 + i * 3, BLK - 2, 2, 1, M_SRC);
  };

  for (let r = 0; r < NROW; r++) {
    const sy = SY_MAX - r;
    for (let c = 0; c < NCOL; c++) {
      const nm = roomAt(SX_MIN + c, sy);
      fillBlock(c, r, classify(SX_MIN + c, sy).rgb);
      markers(c, r, nm);
    }
  }
  // legend: horizontal score gradient across the full width
  const y0 = NROW * BLK;
  for (let x = 0; x < W; x++) {
    const rgb = heat(x / (W - 1));
    for (let y = y0 + LEG_PAD; y < y0 + LEG - LEG_PAD; y++) put(x, y, rgb);
  }

  mkdirSync(dirname(PNG_OUT), { recursive: true });
  writeFileSync(PNG_OUT, encodePng(W, H, img));
  console.log(`PNG ${W}x${H} -> ${PNG_OUT}`);
}

// ============================================================================
//  Run
// ============================================================================
if (WANT_ANSI) renderAnsi();
if (WANT_PNG) renderPng();

const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log(`\nTop ${top.length} rooms by score:`);
console.log("  room      score   mineral  SK-neighbours        enemy(rcl)");
for (const [nm, v] of top) {
  const d = detail.get(nm) || {};
  const sk = d.skNeighbours?.length ? d.skNeighbours.join(",") : "-";
  const enemy = d.enemyNeighbours
    ? `${d.enemyNeighbours}${d.nearestEnemyRcl != null ? `(L${d.nearestEnemyRcl})` : ""}`
    : "-";
  console.log(
    `  ${nm.padEnd(8)}  ${v.toFixed(1).padEnd(6)}  ${String(d.mineral || "-").padEnd(7)}  ${sk.padEnd(19)}  ${enemy}`,
  );
}
