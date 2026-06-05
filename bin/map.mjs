// ============================================================================
//  bin/map.mjs — text room renderer (#163). Invoked by `bin/sapi map <ROOM>`.
//
//  An AI-native "fetch the room" view: a compact single-width ASCII spatial grid
//  (auto-cropped, ANSI-coloured) + opt-in TOON data layers. The grid answers the
//  SPATIAL questions a flat list can't (is the miner ON the container? is the link
//  next to the source? is a hostile between my creep and the exit?); the TOON
//  panels carry the precise per-entity attributes. Designed for tokens + parse-
//  reliability over prettiness (the TOON lesson) — emoji live behind --emoji, for
//  a human glancing at my view. Offline ops tooling; never bundled into the bot.
//
//  Invocation contract (set by the `map)` case in bin/sapi): env SAPI_SERVER,
//  SAPI_SHARD, SCREEPS_TOKEN; room name + flags in argv.
//
//  Data sources:
//   • terrain  — GET {server}/api/game/room-terrain?...&encoded=1 (static; same for --tick)
//   • live     — GET {server}/api/game/room-objects (current tick)
//   • --tick N — GET https://screeps.com/room-history/{shard}/{room}/{base}.json
//                (root host, NOT /season; public, gzip; base = floor(N/100)*100,
//                 chunk = 100 ticks; the newest ~1-2 chunks aren't flushed yet)
//   • role/act — GET {server}/api/user/memory?path=creeps (LIVE only; a past tick
//                has no Memory, so role/act are shown only when the creep still lives)
// ============================================================================
import zlib from "node:zlib";

const SERVER = process.env.SAPI_SERVER || "https://screeps.com/season";
const SHARD = process.env.SAPI_SHARD || "shardSeason";
const TOKEN = process.env.SCREEPS_TOKEN || "";
const HISTORY_HOST = "https://screeps.com"; // room-history lives at the root host, not under /season
const HISTORY_CHUNK = 100; // ticks per history file; the URL base must be a multiple of this

// ---- glyph language ---------------------------------------------------------
// Single-width ASCII (default, token-lean + perfectly aligned) and an emoji table
// (--emoji, human viewing). Emoji SEMANTICS mirror src/lib/Icons.js by convention —
// bin/ never imports from src/, so we keep the table local but speak one vocabulary.
const ASCII = {
  plain: " ", swamp: ",", wall: "#", road: "+", // plain = SPACE: a run of spaces is ~free to
  // tokenize, whereas a glyph per empty tile is one token each (measured with tiktoken o200k:
  // spaces+borders 738 tok vs per-tile dots 1571 tok for the SAME 50×50 scene — 2.1× cheaper).
  // `|` edges (drawGrid) keep the bounds legible once the plains are blank.
  source: "*", mineral: "M", controller: "C", spawn: "S", extension: "e",
  tower: "T", link: "I", storage: "B", container: "o", terminal: "N", lab: "L",
  factory: "F", nuker: "K", powerSpawn: "P", observer: "V", extractor: "X",
  rampart: "%", constructedWall: "W", keeperLair: "@", invaderCore: "!",
  portal: "O", score: "$", tombstone: "t", ruin: "u", energy: ".",
  mine: "m", hostile: "x", // generic creep fallbacks (role letters override `mine`)
};
const ROLE_LETTER = {
  miner: "m", remoteMiner: "m", hauler: "h", remoteHauler: "h", worker: "w",
  remoteWorker: "w", upgrader: "u", reserver: "r", guard: "g", scout: "s",
  escort: "e", filler: "f", harvester: "v",
};
const EMOJI = {
  plain: "⬛", swamp: "🟩", wall: "🟫", road: "🟨",
  source: "⚡", mineral: "🔵", controller: "🎮", spawn: "🏭", extension: "🔸",
  tower: "🗼", link: "🔗", storage: "🏦", container: "📦", terminal: "📮", lab: "⚗️",
  factory: "🏭", nuker: "☢️", powerSpawn: "🔆", observer: "👁", extractor: "⛏",
  rampart: "🟧", constructedWall: "⬜", keeperLair: "💢", invaderCore: "👾",
  portal: "🌀", score: "💰", tombstone: "⚰️", ruin: "🪦", energy: "🟡",
  mine: "🙂", hostile: "💀",
};
const ROLE_EMOJI = {
  miner: "⛏️", remoteMiner: "⛏️", hauler: "🚚", remoteHauler: "🚚", worker: "🔨",
  remoteWorker: "🔨", upgrader: "🎮", reserver: "🚩", guard: "⚔️", scout: "👁️",
  escort: "🛡️", filler: "🪣", harvester: "🌾",
};

// Render priority: a tile shows the most salient object on it (higher = wins).
const PRIORITY = {
  road: 1, container: 2, rampart: 2, constructedWall: 2, extension: 3, link: 3,
  tower: 4, storage: 4, terminal: 4, lab: 4, factory: 4, nuker: 4, powerSpawn: 4,
  observer: 4, extractor: 4, spawn: 5, controller: 5, source: 5, mineral: 5,
  keeperLair: 5, portal: 5, invaderCore: 6, tombstone: 6, ruin: 6, energy: 6,
  score: 8, creep: 9, // creeps + score sit on top so they're never hidden
};

// ANSI 24-bit colour. ours=green, hostile=red, score=gold, infra=cyan, terrain=grey.
const C = {
  reset: "\x1b[0m", wall: "\x1b[38;5;240m", swamp: "\x1b[38;5;22m", plain: "\x1b[38;5;236m",
  road: "\x1b[38;5;238m", source: "\x1b[38;5;220m", mineral: "\x1b[38;5;141m",
  ours: "\x1b[38;5;40m", hostile: "\x1b[38;5;196m", score: "\x1b[38;5;214m",
  infra: "\x1b[38;5;45m", neutral: "\x1b[38;5;250m", ruler: "\x1b[38;5;244m",
};

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.filter((a) => !a.startsWith("-"));
const room = positional[0];
const tickArg = (() => {
  const i = argv.indexOf("--tick");
  return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : null;
})();
const emoji = flags.has("--emoji");
// Colour is OFF by default: ANSI escapes are ~15× the bytes per cell and I read them as
// noise, not colour — that wrecks the token economy this tool exists for. Plain ASCII is
// the AI-native default; colour/emoji is the human's window (--emoji implies colour).
const color = emoji || flags.has("--color");
const noGrid = flags.has("--no-grid");
const all = flags.has("--all");
const want = (layer) => all || flags.has(`--${layer}`);

const LAYERS = ["creeps", "structures", "score", "hostiles", "salvage"];
const GLYPH = emoji ? EMOJI : ASCII;
const ROLEG = emoji ? ROLE_EMOJI : ROLE_LETTER;
if (!color) for (const k in C) C[k] = ""; // strip all ANSI in the default (token-lean) mode

if (flags.has("-h") || flags.has("--help") || !room) {
  printHelp();
  process.exit(room ? 0 : 1);
}

// ---- fetch helpers ----------------------------------------------------------
async function apiGet(path) {
  const res = await fetch(`${SERVER}/api/${path}`, { headers: { "X-Token": TOKEN } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}
// Memory comes back gz:<base64> (same as `bin/sapi mem`); decode to an object.
function decodeMemory(data) {
  if (typeof data === "string" && data.startsWith("gz:")) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
  }
  return data;
}

// Terrain → Uint8Array(2500), index y*50+x; 0 plain / 1 wall / 2 swamp / 3 wall+swamp.
// (Mirror of bin/db.mjs parseTerrain — the canonical decode; inlined so a live render
// needs no sqlite/DB dependency. Standard row-major, never transposed; see #111.)
function parseTerrain(str) {
  const g = new Uint8Array(2500);
  for (let i = 0; i < 2500; i++) g[i] = str.charCodeAt(i) - 48;
  return g;
}

// Live object snapshot: the room-objects array (current tick).
async function fetchLive() {
  const o = await apiGet(`game/room-objects?room=${room}&shard=${SHARD}`);
  return { objects: o.objects || [], users: o.users || {}, tick: null };
}

// Historical object snapshot at tick N: the room-history chunk, gunzipped, sliced to
// the exact tick. base = floor(N/100)*100. Returns {objects, requested, served, stale}.
async function fetchHistory(n) {
  const base = Math.floor(n / HISTORY_CHUNK) * HISTORY_CHUNK;
  const url = `${HISTORY_HOST}/room-history/${SHARD}/${room}/${base}.json`;
  const res = await fetch(url); // public, no auth; fetch auto-gunzips the body
  if (!res.ok) {
    throw new Error(
      `room-history HTTP ${res.status} for tick ${n} (base ${base}). The newest ~1-2 ` +
        `chunks aren't flushed yet — try an older --tick.`
    );
  }
  const chunk = await res.json();
  const ticks = chunk.ticks || {};
  const keys = Object.keys(ticks).map(Number).sort((a, b) => a - b);
  if (!keys.length) throw new Error(`room-history chunk ${base} for ${room} is empty`);
  // The chunk is a FULL snapshot at `base` plus per-tick DELTAS (changed fields per object;
  // a removed object is signalled by null). Fold forward from base to the requested tick to
  // reconstruct the complete state at that tick (clamped to the chunk's last tick).
  const target = Math.min(n, keys[keys.length - 1]);
  const state = {};
  for (const t of keys) {
    if (t > target) break;
    for (const [id, val] of Object.entries(ticks[String(t)])) {
      if (val === null) delete state[id];
      else state[id] = Object.assign(state[id] || {}, val);
    }
  }
  return { objects: Object.values(state), users: {}, tick: target, requested: n };
}

// ---- main -------------------------------------------------------------------
(async () => {
  let terrainStr, snap, mem;
  try {
    const terr = await apiGet(`game/room-terrain?room=${room}&shard=${SHARD}&encoded=1`);
    terrainStr = Array.isArray(terr.terrain) ? terr.terrain[0].terrain : terr.terrain;
    snap = tickArg != null ? await fetchHistory(tickArg) : await fetchLive();
    // Live Memory join (role/act) — only meaningful for the live snapshot.
    if (tickArg == null) {
      try {
        const m = await apiGet(`user/memory?path=creeps&shard=${SHARD}`);
        mem = decodeMemory(m.data) || {};
      } catch {
        mem = {};
      }
    } else {
      mem = {};
    }
  } catch (e) {
    console.error(`map: ${e.message}`);
    process.exit(1);
  }

  const grid = parseTerrain(terrainStr);
  const objs = snap.objects.filter((o) => o && o.type); // guard stray nulls/partials from history
  const myUser = findMyUser(objs, mem); // owner id of our creeps (for ours/hostile colouring)

  console.log(summaryLine(room, snap, objs, grid));
  if (!noGrid) console.log(renderGrid(grid, objs, mem, myUser));
  for (const layer of LAYERS) if (want(layer)) console.log(panel(layer, objs, mem, myUser));
})();

// Our creeps are named `<role>_<id>`; take the role from live Memory if present, else parse the
// name — so history (which carries no Memory) still shows real roles. `act` stays Memory-only.
function roleOf(o, mem) {
  if (o.name && mem[o.name] && mem[o.name].role) return mem[o.name].role;
  if (o.name && o.name.includes("_")) return o.name.split("_")[0];
  return null;
}

// Our user id = the owner of any creep whose name is in our live Memory.
function findMyUser(objs, mem) {
  for (const o of objs) {
    if (o.type === "creep" && o.name && mem[o.name]) return o.user;
  }
  // Fallback: the controller owner (our room).
  const ctrl = objs.find((o) => o.type === "controller" && o.user);
  return ctrl ? ctrl.user : null;
}

// ---- rendering --------------------------------------------------------------
function summaryLine(room, snap, objs, grid) {
  const ctrl = objs.find((o) => o.type === "controller");
  const storage = objs.find((o) => o.type === "storage");
  const nc = objs.filter((o) => o.type === "creep").length;
  const ns = objs.filter((o) => o.type === "score").length;
  const when = snap.tick != null ? `t${snap.tick}${snap.requested !== snap.tick ? ` (req ${snap.requested})` : ""} [history]` : "live";
  const bits = [room, when];
  if (ctrl) bits.push(`RCL${ctrl.level || 0}`);
  if (storage) bits.push(`⚡${Math.round((storage.store?.energy || 0) / 1000)}k`);
  bits.push(`obj ${objs.length}`, `creeps ${nc}`);
  if (ns) bits.push(`💰${ns}`);
  return bits.join(" · ");
}

function renderGrid(grid, objs, mem, myUser) {
  // Top object per tile (highest PRIORITY wins), plus a "is it ours/hostile" tag.
  const cell = new Array(2500).fill(null);
  const place = (x, y, glyph, color, pri) => {
    if (x < 0 || x > 49 || y < 0 || y > 49) return;
    const i = y * 50 + x;
    if (!cell[i] || pri >= cell[i].pri) cell[i] = { glyph, color, pri };
  };
  for (const o of objs) {
    if (o.x == null || o.y == null) continue;
    if (o.type === "creep" || o.type === "powerCreep") {
      const mine = o.user === myUser;
      const g = mine ? ROLEG[roleOf(o, mem)] || GLYPH.mine : GLYPH.hostile;
      place(o.x, o.y, g, mine ? C.ours : C.hostile, PRIORITY.creep);
    } else if (o.type === "score") {
      place(o.x, o.y, GLYPH.score, C.score, PRIORITY.score);
    } else if (GLYPH[o.type]) {
      place(o.x, o.y, GLYPH[o.type], colorFor(o, myUser), PRIORITY[o.type] || 4);
    }
  }
  // Bounding box of content (objects + non-plain terrain), padded — so we don't print
  // 50×50 of mostly-empty (token waste). Falls back to the full room if nothing found.
  const bbox = contentBBox(grid, cell);
  return drawGrid(grid, cell, bbox);
}

function colorFor(o, myUser) {
  if (o.type === "source") return C.source;
  if (o.type === "mineral" || o.type === "extractor") return C.mineral;
  if (o.type === "keeperLair" || o.type === "invaderCore") return C.hostile;
  if (o.user && myUser && o.user !== myUser) return C.hostile;
  if (o.user && o.user === myUser) return C.ours;
  return C.infra;
}

function contentBBox(grid, cell) {
  let x0 = 50, y0 = 50, x1 = -1, y1 = -1;
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const i = y * 50 + x;
      if (cell[i] || grid[i] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: 49, y1: 49 };
  const pad = 2;
  return {
    x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad),
    x1: Math.min(49, x1 + pad), y1: Math.min(49, y1 + pad),
  };
}

function drawGrid(grid, cell, { x0, y0, x1, y1 }) {
  const cw = emoji ? 2 : 1; // emoji cells are ~2 cols; ASCII is 1
  const b = emoji ? "" : "|"; // frame the ASCII grid so the (space) plains keep their bounds
  // Column ruler: the tens digit at every 10th column (e.g. "2" under x=20), offset to sit above
  // the cells (past the 4-char row-label gutter + the left border).
  let ruler = " ".repeat(4 + b.length);
  for (let x = x0; x <= x1; x++) ruler += (x % 10 === 0 ? String((x / 10) % 10) : " ").padEnd(cw, " ");
  const lines = [C.ruler + ruler + C.reset];
  for (let y = y0; y <= y1; y++) {
    let row = C.ruler + String(y).padStart(3) + " " + C.reset + b;
    for (let x = x0; x <= x1; x++) {
      const i = y * 50 + x;
      if (cell[i]) {
        row += cell[i].color + cell[i].glyph + C.reset;
      } else {
        const t = grid[i];
        const sym = t & 1 ? GLYPH.wall : t & 2 ? GLYPH.swamp : GLYPH.plain;
        row += (t & 1 ? C.wall : t & 2 ? C.swamp : C.plain) + sym + C.reset;
      }
    }
    row += b;
    lines.push(row);
  }
  return lines.join("\n");
}

// ---- TOON data panels (hand-emitted; uniform arrays → key[N]{fields}: rows) ---
function toonTable(name, rows, fields) {
  if (!rows.length) return `${name}[0]{${fields.join(",")}}:`;
  const head = `${name}[${rows.length}]{${fields.join(",")}}:`;
  const body = rows.map((r) => "  " + fields.map((f) => fmt(r[f])).join(",")).join("\n");
  return head + "\n" + body;
}
function fmt(v) {
  if (v == null) return "";
  if (typeof v === "string" && /[,\n]/.test(v)) return JSON.stringify(v);
  return String(v);
}

function panel(layer, objs, mem, myUser) {
  if (layer === "creeps") {
    const rows = objs
      .filter((o) => o.type === "creep" && o.user === myUser)
      .map((o) => {
        const m = o.name ? mem[o.name] : null;
        const act = m && m.log && m.log.length ? m.log[m.log.length - 1].act : null;
        return { name: o.name, role: roleOf(o, mem) || "?", x: o.x, y: o.y, hits: o.hits, ttl: o.ticksToLive, act: act || "" };
      });
    return toonTable("creeps", rows, ["name", "role", "x", "y", "hits", "ttl", "act"]);
  }
  if (layer === "structures") {
    const mineTypes = new Set(["spawn", "extension", "tower", "link", "storage", "container", "terminal", "lab", "factory", "nuker", "powerSpawn", "observer", "extractor", "rampart", "constructedWall", "road", "controller"]);
    const rows = objs
      .filter((o) => mineTypes.has(o.type))
      .map((o) => ({ type: o.type, x: o.x, y: o.y, energy: o.store?.energy ?? "", hits: o.hits ?? "", lvl: o.level ?? "" }));
    return toonTable("structures", rows, ["type", "x", "y", "energy", "hits", "lvl"]);
  }
  if (layer === "score") {
    const now = objs.find((o) => o.type === "controller"); // any object to read nothing; ttl is decayTime-based
    const rows = objs
      .filter((o) => o.type === "score")
      .map((o) => ({ x: o.x, y: o.y, amount: o.score, decayTime: o.decayTime }));
    return toonTable("scores", rows, ["x", "y", "amount", "decayTime"]);
  }
  if (layer === "hostiles") {
    const rows = objs
      .filter((o) => (o.type === "creep" || o.type === "powerCreep") && o.user && o.user !== myUser)
      .map((o) => ({ user: o.user, x: o.x, y: o.y, hits: o.hits, parts: (o.body || []).length }));
    const sr = objs
      .filter((o) => o.user && o.user !== myUser && o.type !== "creep" && o.type !== "controller" && o.x != null)
      .map((o) => ({ user: o.user, x: o.x, y: o.y, hits: o.hits, parts: o.type }));
    return toonTable("hostiles", rows.concat(sr), ["user", "x", "y", "hits", "parts"]);
  }
  if (layer === "salvage") {
    const rows = objs
      .filter((o) => o.type === "tombstone" || o.type === "ruin" || o.type === "energy")
      .map((o) => ({ type: o.type, x: o.x, y: o.y, energy: o.store?.energy ?? o.amount ?? "", ttl: o.ticksToDecay ?? "" }));
    return toonTable("salvage", rows, ["type", "x", "y", "energy", "ttl"]);
  }
  return "";
}

// ---- help / legend ----------------------------------------------------------
function printHelp() {
  const g = ASCII;
  const legend = [
    `terrain  ${g.plain} plain   ${g.swamp} swamp   ${g.wall} wall   ${g.road} road`,
    `natural  ${g.source} source  ${g.mineral} mineral ${g.controller} controller  ${g.keeperLair} keeperLair  ${g.invaderCore} invaderCore`,
    `infra    ${g.spawn} spawn   ${g.extension} extension ${g.tower} tower ${g.link} link ${g.storage} storage ${g.container} container ${g.terminal} terminal`,
    `         ${g.lab} lab ${g.factory} factory ${g.nuker} nuker ${g.powerSpawn} powerSpawn ${g.observer} observer ${g.extractor} extractor ${g.rampart} rampart ${g.constructedWall} wall`,
    `objects  ${g.score} score   ${g.tombstone} tombstone ${g.ruin} ruin  ${g.energy} dropped-energy  ${g.portal} portal`,
    `creeps   ours by role: m miner  h hauler  w worker  u upgrader  g guard  s scout  e escort  f filler  r reserver  (x hostile)`,
  ].join("\n  ");
  console.log(`Usage: bin/sapi map <ROOM> [layers] [--tick N] [--emoji] [--main]

Renders a room as an ASCII spatial grid (auto-cropped, ANSI-coloured) plus opt-in
TOON data layers. Default shows the grid + a one-line summary only.

Layers (opt-in — pull only what the question needs):
  --creeps        our creeps: creeps[N]{name,role,x,y,hits,ttl,act}
  --structures    structures[N]{type,x,y,energy,hits,lvl}
  --score         scores[N]{x,y,amount,decayTime}
  --hostiles      enemy creeps + structures
  --salvage       tombstones, ruins, dropped energy
  --all           every layer
  --no-grid       tables only, drop the map

Time:
  --tick N        snapshot at tick N via room-history (rounded down to a multiple of
                  ${HISTORY_CHUNK}; the newest ~1-2 chunks aren't flushed yet). Default: live.
                  History has no Memory, so role/act are blank for a past tick.

View:
  --emoji         swap the glyph table for emoji/colour (human viewing)
  --main          target shard2 (handled by bin/sapi before this runs)
  -h, --help      this help + the glyph legend

Legend (ASCII):
  ${legend}`);
}
