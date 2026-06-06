import { TrafficManager } from "../../../lib/TrafficManager.js";
import { KITE_RANGE } from "../../../lib/Movement.js";

// ============================================================================
//  Field steering (#190) — magnet / potential-field movement for COMBAT atoms.
//
//  Instead of "pick a target tile, then A* to it", a combat creep's motion FALLS OUT
//  of a sum of magnets: each magnet contributes a scalar potential at every tile by its
//  distance, and the creep steps to the lowest-potential of its 9 candidate tiles
//  (current + 8 neighbours). Attract lowers potential toward a source; repel raises it
//  near a source (decaying to 0 at its range). Magnets SUPERPOSE — "hold ⊕ dodge ⊕
//  separation" is literal vector addition — so a held squad keeps its rally point, fans
//  ≥3 apart, AND dodges incoming fire all at once. (This closes #185: the old
//  ceil(sqrt(N)) pin clustered the squad inside one rangedMassAttack and they were wiped.)
//
//  HYBRID — combat ONLY, and only IN-THEATRE: the behaviour reaches the room by A*
//  (creep.travelTo); the field drives the tile-by-tile dance once inside. A potential
//  field has local minima (a concave pocket traps it), so it is deliberately kept LOCAL
//  (9 tiles) with A* owning global navigation. Economy roles never touch this module.
//
//  RESOLVER: a field step REGISTERS its chosen tile with the TrafficManager directly
//  (not via travelTo) — so it plugs into the same priority resolution (it can shove an
//  idler) WITHOUT thrashing the A* path cache (creep.memory._t) that transit relies on.
//
//  Invariants honoured (see the #190 research): the exit ring (x/y 0|49) and natural
//  walls are ∞ (never leave the room, #119); friendly creeps are NOT blocked (the
//  resolver shoves them by priority, #130); only natural terrain is precomputed (static),
//  obstacle structures + hostile creeps are a cheap per-tick overlay.
// ============================================================================

// Tunables (ship and observe — we live-tune on the warband). Potentials are summed and
// the min tile wins, so these are RELATIVE weights, not absolute costs.
const SWAMP_POT = 2; // standing in swamp is mildly bad (don't camp a marsh)
const OPENNESS_RADIUS = 2; // how far the enclosure scan looks — wide enough to "see" a narrow pocket
const OPENNESS_WEIGHT = 2; // per unit of DISTANCE-WEIGHTED enclosure. A 1-tile-greedy field can be lured
// into a cave/dead-end where the only exit is back through the attacker; this raises the potential of
// ENCLOSED ground (corridors, pockets, corners) so a kiter never enters one — it fights in the open and
// stays out of the trap. Also the principled #130 self-corner fix (a corner is enclosed = high cost).
// Enclosure is summed over nearby wall/edge tiles WEIGHTED BY CLOSENESS ((R+1−d)): a wall right next to
// the tile dominates, a wall two tiles out only hints — matching the rest of the field's distance decay.
//
// An enemy's magnet is the SUM of its body parts' potentials, and each combat-relevant part carries
// TWO kernels: a SHORT repel (its danger zone — don't get hit) and a WIDE attract (its kill-priority —
// who to converge on first). Both polarities at once means: pulled toward the high-value target from
// across the room, then held at reach by the short repel. Priority falls out of the wide attract:
//   • RANGED/ATTACK parts — strong attract (kill the armed units first) + short repel (their fire).
//   • HEAL parts — strong attract, no repel (a healer is the #185 priority kill; dive a lone one).
//   • MOVE parts — small attract: a fast hauler (more MOVE, harder to catch) pulls the squad first,
//     a slow miner (less MOVE) is left for after — so fast escapers die before they flee.
//   • WORK/CARRY/TOUGH — no pull (economy/soak, mopped last).
// So a 6×RANGED+2×HEAL core repels hard at range 3 (kite it, #185) yet still draws focus; a room of
// haulers is killed fastest-first; all emergent from one summation, no target-priority code.
// Offence repel MUST exceed a unit's own attract, or attraction wins inside the repel range and the
// kiter dives onto the enemy instead of holding reach: the equilibrium sits at `range` only when the
// inside-range slope (attract − repel) is negative. So repel-per-part > attract-per-part(+base).
const RANGED_REPEL = 8; // per RANGED_ATTACK part — repulsion inside kite range (its kill-zone)
const MELEE_REPEL = 8; // per ATTACK part — keep a ranged unit out of melee reach
const ARMED_ATTRACT = 3; // per RANGED/ATTACK part — wide pull: engage armed units first (priority, not dive)
const HEAL_ATTRACT = 3; // per HEAL part — wide pull: focus-kill the enemy healer
const MOVE_ATTRACT = 1; // per MOVE part — faint pull: kill the fast (more MOVE) before the slow
const KEEP_ATTRACT = 2; // baseline pull toward threats for a KITER (always close to shooting range 3);
// held units omit it (their anchor sets position).
const SEP_RANGE = 3; // squadmates repel each other within this — ≥3 so one rangedMassAttack (range 3)
// can't catch two of us (the #185 anti-cluster rule).
const SEP_STRENGTH = 6; // separation push per tile inside SEP_RANGE
const ANCHOR_PULL = 3; // hold-point attraction per tile — WEAK so dodge/separation can pull a held
// creep off the exact tile to survive, while still drawing it back to the ground it was told to hold.
const STEER_PRIORITY = 3; // movement priority for the resolver (combat rank, == Combatant/Guard)

const idx = (x, y) => y * 50 + x; // row-major tile index (standard Screeps terrain layout)

// Static terrain potential per room — built once and cached forever (terrain never changes).
const _terrainPot = new Map(); // roomName -> Float32Array(2500)
// Obstacle structures + hostile creeps that block a tile — cached per room per tick.
const _blockCache = new Map(); // roomName -> { tick, blocked: Set<idx> }

// The static field: ∞ on the exit ring (#119) and natural walls; swamp costs SWAMP_POT; every
// tile is then raised by its distance-weighted enclosure so caves, dead-ends and corners are shunned.
function terrainPotential(room) {
  const cached = _terrainPot.get(room.name);
  if (cached) return cached;
  const pot = new Float32Array(2500);
  const terrain = room.getTerrain();
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      if (x === 0 || x === 49 || y === 0 || y === 49) {
        pot[idx(x, y)] = Infinity; // exit ring — stepping here changes rooms
        continue;
      }
      const t = terrain.get(x, y);
      pot[idx(x, y)] = t === TERRAIN_MASK_WALL ? Infinity : t === TERRAIN_MASK_SWAMP ? SWAMP_POT : 0;
    }
  }
  // Enclosure pass: raise each walkable tile by its distance-weighted surrounding wall/edge mass, so a
  // kiter "sees" a cave/dead-end/corner (high enclosure) and never steps into it. A wall at chebyshev d
  // counts (R+1−d) — adjacent walls dominate, far ones only hint (the field's distance decay applied to
  // terrain). Out-of-bounds and ∞ tiles (walls + the exit ring) are the enclosing mass.
  const R = OPENNESS_RADIUS;
  for (let y = 1; y < 49; y++) {
    for (let x = 1; x < 49; x++) {
      const i = idx(x, y);
      if (pot[i] === Infinity) continue;
      let enclosure = 0;
      for (let dx = -R; dx <= R; dx++) {
        for (let dy = -R; dy <= R; dy++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          const wall = nx < 0 || nx > 49 || ny < 0 || ny > 49 || pot[idx(nx, ny)] === Infinity;
          if (wall) enclosure += R + 1 - Math.max(Math.abs(dx), Math.abs(dy));
        }
      }
      pot[i] += enclosure * OPENNESS_WEIGHT;
    }
  }
  _terrainPot.set(room.name, pot);
  return pot;
}

// Tiles a creep can't stand on this tick: obstacle structures + enemy ramparts + hostile creeps, plus
// ANCHORED friendlies (miner on post / spawning / fatigued) — the resolver can't shove those, and a
// root mover gets only its one chosen tile, so steering onto an anchored ally would FREEZE the unit
// (field steps have no stuck-counter). Shovable friendlies stay walkable — the resolver pushes them by
// priority (#130). `isAnchored` is reused from the resolver so "can't be shoved" stays single-sourced.
function blockedTiles(room) {
  const cached = _blockCache.get(room.name);
  if (cached && cached.tick === Game.time) return cached.blocked;
  const blocked = new Set();
  for (const s of room.find(FIND_STRUCTURES)) {
    const enemyRampart = s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic;
    if (enemyRampart || OBSTACLE_OBJECT_TYPES.includes(s.structureType)) blocked.add(idx(s.pos.x, s.pos.y));
  }
  for (const h of room.find(FIND_HOSTILE_CREEPS)) blocked.add(idx(h.pos.x, h.pos.y));
  const tm = TrafficManager.for(room);
  for (const c of room.find(FIND_MY_CREEPS)) if (tm.isAnchored(c)) blocked.add(idx(c.pos.x, c.pos.y));
  _blockCache.set(room.name, { tick: Game.time, blocked });
  return blocked;
}

// A magnet's potential contribution at chebyshev distance d: repulsion (decays to 0 at range)
// plus attraction (grows with distance, so closer = lower = pulled in).
function contribution(m, d) {
  let c = m.attract * d;
  if (m.range && d < m.range) c += m.repel * (m.range - d);
  return c;
}

// Summed potential at a tile: static terrain + every magnet.
function tilePotential(x, y, terrain, magnets) {
  const base = terrain[idx(x, y)];
  if (base === Infinity) return Infinity;
  let p = base;
  for (const m of magnets) {
    const d = Math.max(Math.abs(x - m.x), Math.abs(y - m.y));
    p += contribution(m, d);
  }
  return p;
}

// A tiny deterministic per-creep, per-tile offset (< the smallest real potential step) so two
// mirror-image creeps break ties toward DIFFERENT tiles instead of fighting for the same one.
function jitter(creep, x, y) {
  let h = x * 53 + y * 97;
  for (let i = 0; i < creep.name.length; i++) h = (h * 31 + creep.name.charCodeAt(i)) >>> 0;
  return (h % 100) / 1000; // 0 .. 0.099
}

// ---- public API -----------------------------------------------------------

// Step down the summed potential field: score the 9 candidate tiles, register the best with the
// resolver. "Never worse than staying" — the current tile is the baseline (no jitter), so on flat
// ground the creep holds; it only moves when a neighbour is genuinely lower (jitter breaks ties
// among neighbours). Emits ONLY a move intent — the behaviour fires its own attack/heal the same tick.
export function steer(creep, magnets, opts = {}) {
  if (creep.fatigue > 0 || creep.spawning) return;
  const room = creep.room;
  const terrain = terrainPotential(room);
  const blocked = blockedTiles(room);
  const cx = creep.pos.x;
  const cy = creep.pos.y;
  let best = null;
  let bestP = tilePotential(cx, cy, terrain, magnets); // stay baseline
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue; // interior only (ring is ∞ anyway)
      if (blocked.has(idx(x, y))) continue;
      const p = tilePotential(x, y, terrain, magnets) + jitter(creep, x, y);
      if (p < bestP) {
        bestP = p;
        best = new RoomPosition(x, y, room.name);
      }
    }
  }
  if (best) TrafficManager.for(room).register(creep, best, opts.priority ?? STEER_PRIORITY);
}

// Magnet builders — the recipes behaviours compose. Each returns magnet objects {x,y,repel,attract,range}.

// Priority profiles ("colours", #190) — the per-part ATTRACT weights, selectable per behaviour, so a
// behaviour toggles which target-priority layers are live. Repulsion is always-on (safety: never get
// caught in the fire, whatever the priority); only the attract layers change.
//  • ENGAGE — kiters: pull onto armed units + healers first (then fast economy), and a baseline pull
//    so a lone skirmisher always closes to shooting range.
//  • HOLD — held units: same priority lean, but no baseline (their anchor positions them).
//  • DENY — economy denial / lure-proof: zero the part weights so all enemies are EQUAL → kill the
//    NEAREST (a flat base pull). The toggle Yevhenii described — disable armed-priority to clear haulers.
export const PRIORITY_ENGAGE = { ranged: ARMED_ATTRACT, attack: ARMED_ATTRACT, heal: HEAL_ATTRACT, move: MOVE_ATTRACT, base: KEEP_ATTRACT };
export const PRIORITY_HOLD = { ranged: ARMED_ATTRACT, attack: ARMED_ATTRACT, heal: HEAL_ATTRACT, move: MOVE_ATTRACT, base: 0 };
export const PRIORITY_DENY = { ranged: 0, attack: 0, heal: 0, move: 0, base: KEEP_ATTRACT };

// One enemy's magnet: a short always-on offence repel (its danger zone) + a wide attract summed from
// its parts weighted by the chosen priority profile (who to converge on first).
function enemyMagnet(enemy, w) {
  const ranged = enemy.getActiveBodyparts(RANGED_ATTACK);
  const attack = enemy.getActiveBodyparts(ATTACK);
  const repel = ranged * RANGED_REPEL + attack * MELEE_REPEL;
  const attract =
    ranged * w.ranged +
    attack * w.attack +
    enemy.getActiveBodyparts(HEAL) * w.heal +
    enemy.getActiveBodyparts(MOVE) * w.move +
    w.base;
  // range only gates the repel; a unit with no offence (a lone healer / harmless creep) is pure
  // attract → range 0 so it's dived all the way in (the min sits at d=0), not held at reach.
  return { x: enemy.pos.x, y: enemy.pos.y, repel, attract, range: repel > 0 ? KITE_RANGE : 0 };
}

// The composite enemy field: every hostile as a body-derived magnet under the given priority profile.
// Pure offence → repel (hold reach); pure healer → strong attract (dive it); a hauler pack under DENY
// → equalised (kill nearest). All emergent from the summation.
export function enemyField(enemies, weights = PRIORITY_ENGAGE) {
  return enemies.map((e) => enemyMagnet(e, weights));
}

// Spread from in-room squadmates so one AOE can't catch two (#185). Room-local by design.
export function separation(creep) {
  const tag = creep.memory.warband;
  if (!tag) return [];
  return creep.room
    .find(FIND_MY_CREEPS)
    .filter((c) => c.memory.warband === tag && c.name !== creep.name)
    .map((c) => ({ x: c.pos.x, y: c.pos.y, repel: SEP_STRENGTH, attract: 0, range: SEP_RANGE }));
}

// Weak wide pull toward a held point — the creep returns to its ground but lets dodge/separation
// pull it off the exact tile to survive.
export function attract(pos, strength = ANCHOR_PULL) {
  return { x: pos.x, y: pos.y, repel: 0, attract: strength, range: 0 };
}
