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
// state colours for non-scored cells
const C_EMPTY = [22, 22, 28]; // not collected
const C_BLOCK = [52, 52, 60]; // collected but unclaimable (highway/center/SK)
const C_OWNED = [205, 40, 175]; // owned by a player

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

const owned = new Set(
  db.prepare(`SELECT name FROM ownership WHERE owner IS NOT NULL`).all().map((r) => r.name),
);
if (owned.size === 0) {
  console.log("note: ownership table empty — all rooms render as unowned (run `collect.mjs --owners`)");
}

const score = new Map(); // name -> total
if (FROM) {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const list = d.rooms || d.candidates || d;
  for (const r of list) if (r && r.total != null && !r.error) score.set(r.room, r.total);
  console.log(`loaded ${score.size} precomputed scores from ${FROM}`);
} else {
  const claimable = cells.filter((c) => c.controller === 1);
  console.log(`scoring ${claimable.length} claimable rooms offline (no API)...`);
  let done = 0;
  for (const c of claimable) {
    let r;
    try { r = await scoreRoom(c.name); } catch { /* not collected / unscorable */ }
    if (r && !r.error && r.total != null) score.set(c.name, r.total);
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

// classify a grid coordinate into [r,g,b] + a glyph for ANSI. Every glyph is
// exactly 2 chars wide so columns stay aligned under the coloured background.
function classify(sx, sy) {
  const nm = roomAt(sx, sy);
  if (owned.has(nm)) return { rgb: C_OWNED, glyph: "##" };
  if (score.has(nm)) return { rgb: heat(norm(score.get(nm))), glyph: "  " };
  const m = meta.get(nm);
  if (!m) return { rgb: C_EMPTY, glyph: "··" }; // not collected
  if (!m.claimable) return { rgb: C_BLOCK, glyph: "  " }; // highway/center/SK
  return { rgb: C_EMPTY, glyph: "··" }; // claimable but unscored (walled/edge)
}

// ============================================================================
//  ANSI terminal grid
// ============================================================================
function renderAnsi() {
  const MARGIN = 4; // width of the row label gutter
  const bg = (rgb, txt) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${txt}\x1b[0m`;

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
    `\nlegend: ${bg(C_EMPTY, "··")} uncollected/unscored  ${bg(C_BLOCK, "  ")} highway/center/SK  ` +
    `${bg(C_OWNED, "##")} owned   score ${bg(heat(0), "  ")}${bg(heat(0.5), "  ")}${bg(heat(1), "  ")} ` +
    `low(${lo.toFixed(0)})→high(${hi.toFixed(0)})`,
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

  for (let r = 0; r < NROW; r++) {
    const sy = SY_MAX - r;
    for (let c = 0; c < NCOL; c++) {
      fillBlock(c, r, classify(SX_MIN + c, sy).rgb);
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
for (const [nm, v] of top) console.log(`  ${nm.padEnd(8)} ${v.toFixed(1)}`);
