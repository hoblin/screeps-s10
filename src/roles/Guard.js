import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

const KITE_RANGE = 3; // RANGED_ATTACK reach — a ranged guard fights from exactly here
const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: future core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body

// ============================================================================
//  Guard — the colony's combat creep: clears a contested remote so the economy
//  can flow back (#118, Levels 2-3 of the threat ladder).
//
//  A dumb executor (per the domain-controller doctrine): GuardOverlord decides
//  WHICH hot room is winnable and stamps it (+ the body TYPE) at spawn; this role
//  travels there, kills the armed threat, mops up the harmless stragglers (scouts /
//  reservers), then GARRISONS the room — parks on its controller and holds for life,
//  re-engaging anything that wanders in (#128). It never recycles on clear (a
//  stationed guard answers the next poke with no rebuild and keeps the room's intel
//  fresh via vision); only the overlord releasing it (room left the footprint) sends
//  it home. Bailing on a false alarm happens only in transit (room cooled en route).
//
//  Type is rock-paper-scissors to the enemy profile (chosen by the overlord):
//   • "ranged" — RANGED_ATTACK + HEAL + MOVE: kites melee (they can't reach us) and
//     out-sustains a ranged mirror. The robust counter to any MOBILE threat.
//   • "melee"  — ATTACK + MOVE: cheap burst for a threat that can't kite back
//     (an invader core / structure). Higher DPS-per-energy when kiting isn't needed.
// ============================================================================
export class Guard extends Role {
  // Above idle/work roles but below the core haul/mine economy: a guard mostly lives
  // in a remote room, so it rarely contends home traffic, but it still has somewhere
  // to be — it shouldn't be shoved aside by an idle worker.
  static movementPriority = 3;

  // Which counter to field for an enemy part-profile. Any MOBILE combat (ranged or
  // melee) → "ranged" (kites melee, mirrors+outlasts ranged; melee can't catch an
  // equal-speed kiter in the open, so we never melee a mobile enemy). Only a threat
  // with no mobile combat (an invader core) gets cheap "melee" burst.
  static counterType(profile) {
    if (!profile) return "ranged";
    return profile.ranged > 0 || profile.attack > 0 ? "ranged" : "melee";
  }

  // Dynamic body: type from the enemy profile, SIZE from the spawn budget. (TOUGH
  // padding and a fuller RPS matrix are noted refinements; v1 wins winnable fights
  // by out-sizing — the overlord only sends a guard whose power already beats the
  // assessed threat.)
  static bodyFor(energyBudget, profile) {
    if (this.counterType(profile) === "melee") {
      return bodyFromTemplate([ATTACK, MOVE], { extra: [ATTACK, MOVE], max: MELEE_MAX, energy: energyBudget });
    }
    // ranged: base carries one HEAL (self-sustain) + 2 MOVE; each extra adds a
    // RANGED_ATTACK+MOVE, so the body stays ~1:1 move-to-part (full speed on roads).
    return bodyFromTemplate([RANGED_ATTACK, MOVE, HEAL, MOVE], {
      extra: [RANGED_ATTACK, MOVE],
      max: RANGED_MAX,
      energy: energyBudget,
    });
  }

  static run(creep, colony) {
    const room = creep.memory.guardRoom;
    if (!room) return this.recycleAtHome(creep, colony); // released (off-map) → recycle

    // In transit: bail only if we can SEE the room is truly empty (no hostiles at
    // all) — a confirmed false alarm. We do NOT bail on !isHot: isHot is lethal-only,
    // so it drops the moment the armed threat dies while a reserver/scout still needs
    // mopping; and we never bail blind (no vision → trust the dispatch, keep going).
    // The on-arrival scan below then decides mop / park / (nothing to do →) garrison.
    if (creep.room.name !== room) {
      const seen = Game.rooms[room];
      if (seen && seen.find(FIND_HOSTILE_CREEPS).length === 0) {
        creep.memory.guardRoom = null;
        return this.recycleAtHome(creep, colony);
      }
      this.note(creep, "guard:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return;
    }

    // On station. Heal, then sweep EVERY hostile — armed first, then mop the harmless
    // stragglers (scouts, reservers contesting our reservation) so the room is left
    // truly clean. Once clean, garrison the controller and hold for life.
    if (creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (!hostiles.length) {
      const ctrl = creep.room.controller;
      if (ctrl && !creep.pos.inRangeTo(ctrl, 1)) {
        this.note(creep, "guard:to-post");
        creep.travelTo(ctrl, { range: 1 });
      } else {
        this.note(creep, "guard:park"); // garrison: defend the controller, deny reservers, keep intel fresh
      }
      return;
    }
    const armed = hostiles.filter((h) => Threat.combatPower(h) > 0);
    const target = creep.pos.findClosestByRange(armed.length ? armed : hostiles);

    if (creep.memory.guardType === "melee") {
      this.note(creep, "guard:melee");
      if (creep.attack(target) === ERR_NOT_IN_RANGE) creep.travelTo(target, { range: 1 });
      return;
    }

    // Ranged: shoot from range 3 and kite — step away if the enemy closes inside 3,
    // close if it's drifting out, so we keep dealing damage while taking little.
    this.note(creep, "guard:ranged");
    const range = creep.pos.getRangeTo(target);
    if (hostiles.length > 1 && range <= 1) creep.rangedMassAttack();
    else if (range <= KITE_RANGE) creep.rangedAttack(target);
    if (range < KITE_RANGE) this.kiteAway(creep, armed.length ? armed : hostiles);
    else if (range > KITE_RANGE) creep.travelTo(target, { range: KITE_RANGE });
  }

  // Retreat to restore kite distance WITHOUT self-cornering (#130). The death case was
  // guard_8142 kiting straight into the west edge and freezing. A greedy "best adjacent
  // tile" still self-traps in concave terrain (a swamp/wall pocket) because it only looks
  // one tile ahead — so we flee with a real path search: PathFinder routes AWAY from EVERY
  // threat with full lookahead, stepping around small obstacles and never into a dead end,
  // and shuns swamp via the default terrain cost. The cost matrix blocks room-exit tiles
  // (#119 — stay in the room), obstacle structures, and other creeps. We take the first
  // step and re-plan next tick; an empty path (boxed in, or already at range) → hold and
  // keep firing (the ranged shot above already fired this tick).
  static kiteAway(creep, threats) {
    const goals = threats.map((t) => ({ pos: t.pos, range: KITE_RANGE }));
    const { path } = PathFinder.search(creep.pos, goals, {
      flee: true,
      maxRooms: 1,
      roomCallback: () => this.kiteCostMatrix(creep.room),
    });
    if (path.length) creep.move(creep.pos.getDirectionTo(path[0]));
  }

  // Cost matrix for the kite flee search: hard-block the room-exit ring (#119 — never
  // leave the room), every non-walkable structure, and every other creep (can't path onto
  // an occupied tile). Walls come free from terrain; swamp stays costly via PathFinder's
  // default swampCost, so the flee naturally prefers plains.
  static kiteCostMatrix(room) {
    const matrix = new PathFinder.CostMatrix();
    for (let i = 0; i < 50; i++) {
      matrix.set(0, i, 0xff);
      matrix.set(49, i, 0xff);
      matrix.set(i, 0, 0xff);
      matrix.set(i, 49, 0xff);
    }
    for (const s of room.find(FIND_STRUCTURES)) {
      if (OBSTACLE_OBJECT_TYPES.includes(s.structureType)) matrix.set(s.pos.x, s.pos.y, 0xff);
    }
    for (const c of room.find(FIND_CREEPS)) matrix.set(c.pos.x, c.pos.y, 0xff);
    return matrix;
  }
}
