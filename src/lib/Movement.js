// ============================================================================
//  Movement — shared pathfinding cost layers (#145) + the ranged kite flee-step (#188).
//
//  The danger layer makes tiles within an armed RANGED hostile's reach EXPENSIVE
//  (not impassable), so non-combat creeps detour around the kill-zone instead of
//  pathing straight through it and getting one-shot (a scout died exactly this way).
//  Costing, not blocking: a creep with no safe route still flees through rather than
//  freezing (the #130 self-corner lesson).
//
//  Opt-in, never global: combat creeps (guard/hunter/combatant) must APPROACH the threat to
//  kite/clear it, so they keep plain travel + their own flee search. A caller asks for
//  the layer with `creep.travelTo(target, { avoidHostiles: true })` — Creep.travel.js
//  injects `dangerCallback` as the path's costCallback, which ADDS danger onto the
//  structure/road-costed matrix the engine hands it (so roads/obstacles are preserved).
//
//  Hostile positions aren't in the intel substrate (it stores only the scalar threat),
//  so we read them live — once per room per tick, cached (the TrafficManager pattern) so
//  many creeps pathing the same room share one scan.
//
//  KITE_RANGE (RANGED_ATTACK reach) is the shared combat distance the atom layer reads.
//
//  kiteAway (#188, restored #280) is the ranged-kite flee-step — the shared combat-movement
//  primitive the kite atom uses to hold reach. The #190 magnet field briefly replaced it, but a
//  greedy 9-tile local field self-corners (local minima) and bails on fatigue; the PathFinder flee
//  has FULL lookahead, so it routes away from EVERY threat around walls/chokes without cornering
//  (the property the field claimed but never had). Reverted to the flee in #280.
// ============================================================================

const DANGER_REACH = 4; // RANGED reach (3) + 1 for the enemy's own step toward us
const DANGER_COST = 12; // additive per kill-zone tile — above swamp (5) so a detour wins; < 255 (never a block)

// RANGED_ATTACK reach — the ideal kite distance and the flee goal range. The single
// source the Kite atom reads; Guard/FocusFire still define their own pending #189.
export const KITE_RANGE = 3;

const _spotCache = new Map(); // roomName -> { tick, spots: [{x,y}] }  (armed ranged hostiles)
const _kiteMatrixCache = new Map(); // roomName -> { tick, matrix }  (shared by every kiter fleeing this room/tick)

export const Movement = {
  // Live positions of armed RANGED hostiles in the room, cached once per room per tick.
  // Only ranged threats project a kill-zone worth detouring around; melee can't reach a
  // passing creep, and a guard handles whatever's actually contesting.
  rangedHostiles(room) {
    const cached = _spotCache.get(room.name);
    if (cached && cached.tick === Game.time) return cached.spots;
    const spots = room
      .find(FIND_HOSTILE_CREEPS)
      .filter((h) => h.getActiveBodyparts(RANGED_ATTACK) > 0)
      .map((h) => ({ x: h.pos.x, y: h.pos.y }));
    _spotCache.set(room.name, { tick: Game.time, spots });
    return spots;
  },

  // Add the danger overlay onto an existing CostMatrix (the one the engine hands the
  // costCallback, already carrying road/structure costs). Additive + capped below 255 so
  // overlapping kill-zones stack but never become an impassable block.
  addDanger(matrix, room) {
    for (const s of this.rangedHostiles(room)) {
      for (let dx = -DANGER_REACH; dx <= DANGER_REACH; dx++) {
        for (let dy = -DANGER_REACH; dy <= DANGER_REACH; dy++) {
          const x = s.x + dx;
          const y = s.y + dy;
          if (x < 0 || x > 49 || y < 0 || y > 49) continue;
          const base = matrix.get(x, y);
          if (base >= 255) continue; // already impassable (wall/obstacle) — never unblock it
          matrix.set(x, y, Math.min(254, base + DANGER_COST));
        }
      }
    }
  },

  // A findPathTo costCallback that adds the danger overlay for any room we can see (no
  // vision → return the matrix untouched; we can't know the kill-zone there).
  dangerCallback(roomName, matrix) {
    const room = Game.rooms[roomName];
    if (room) this.addDanger(matrix, room);
    return matrix;
  },

  // Step one tile AWAY from every threat to restore kite distance, without self-cornering (#188/#280):
  // a real PathFinder flee with full lookahead — it routes away from ALL threats at once around walls
  // and chokes (a greedy 1-tile field can't, and self-traps in a concave pocket — the #130 lesson).
  // Executed via creep.travelTo (path cache + stuck-counter + TrafficManager registration), never a raw
  // move. Empty path (boxed in / already at reach) → no step, the caller fired its shot the same tick.
  kiteAway(creep, threats) {
    if (!threats.length) return;
    const matrix = this.kiteCostMatrix(creep.room); // built once per call, not per callback
    const goals = threats.map((t) => ({ pos: t.pos, range: KITE_RANGE }));
    const { path } = PathFinder.search(creep.pos, goals, { flee: true, maxRooms: 1, roomCallback: () => matrix });
    if (path.length) creep.travelTo(path[0]);
  },

  // Cost matrix for the kite flee search: hard-block the room-exit ring (#119 — a flee never leaves the
  // room), obstacle structures + enemy ramparts, and every hostile-occupied tile. Natural walls come free
  // from the engine. CACHED per room per tick (#281 review): structures/hostiles are fixed within a tick, so
  // many kiters/medics fleeing the same room share ONE matrix instead of each rescanning every structure.
  kiteCostMatrix(room) {
    const cached = _kiteMatrixCache.get(room.name);
    if (cached && cached.tick === Game.time) return cached.matrix;
    const matrix = new PathFinder.CostMatrix();
    for (let i = 0; i < 50; i++) {
      matrix.set(0, i, 0xff);
      matrix.set(49, i, 0xff);
      matrix.set(i, 0, 0xff);
      matrix.set(i, 49, 0xff);
    }
    for (const s of room.find(FIND_STRUCTURES)) {
      if (this.blocksMovement(s)) matrix.set(s.pos.x, s.pos.y, 0xff);
    }
    for (const c of room.find(FIND_HOSTILE_CREEPS)) matrix.set(c.pos.x, c.pos.y, 0xff);
    _kiteMatrixCache.set(room.name, { tick: Game.time, matrix });
    return matrix;
  },

  // Does a structure block a creep's tile — an obstacle type, or an enemy rampart (can't stand on it).
  blocksMovement(structure) {
    if (structure.structureType === STRUCTURE_RAMPART) return !structure.my && !structure.isPublic;
    return OBSTACLE_OBJECT_TYPES.includes(structure.structureType);
  },
};
