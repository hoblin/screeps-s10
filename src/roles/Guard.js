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
    if (range < KITE_RANGE) this.kiteAway(creep, target, colony);
    else if (range > KITE_RANGE) creep.travelTo(target, { range: KITE_RANGE });
  }

  // Step back to restore kite distance WITHOUT self-cornering (#130). The old kite
  // moved blindly opposite the target and froze when that single tile was a wall or a
  // room exit (the #119 safety) — which is exactly how guard_8142 died, pinned at the
  // west edge. Instead, score every OPEN neighbour by distance-from-target and take the
  // farthest. Ties break toward home (lure): drag a chaser back toward our tower, or at
  // home stay inside tower coverage. Because distance is the PRIMARY key, a tile toward
  // an enemy sitting between us and home loses on distance — so we never lure into the
  // enemy and need no explicit "is the invader between us and home" test. Fully boxed in
  // (no open tile) → hold and keep firing rather than freeze.
  static kiteAway(creep, target, colony) {
    const tiles = this.openNeighbours(creep);
    if (!tiles.length) return;
    const lure = this.lureScorer(creep, colony);
    let best = null;
    let bestScore = -Infinity;
    for (const tile of tiles) {
      // Distance dominates (×100); the lure bias (0..49) only separates equal-distance
      // tiles, so it never trades away kite distance for a step toward home.
      const score = tile.getRangeTo(target) * 100 + lure(tile);
      if (score > bestScore) {
        bestScore = score;
        best = tile;
      }
    }
    if (best) creep.move(creep.pos.getDirectionTo(best));
  }

  // The adjacent tiles a guard may retreat onto: INTERIOR only (never x/y 0|49 — the
  // #119 exit safety keeps it from leaving the room), not a wall, and not blocked by a
  // non-walkable structure or another creep. Returns RoomPositions (possibly empty).
  static openNeighbours(creep) {
    const terrain = creep.room.getTerrain();
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = creep.pos.x + dx;
        const y = creep.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue; // #119: never an exit tile
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (creep.room.lookForAt(LOOK_CREEPS, x, y).length) continue;
        const blocked = creep.room
          .lookForAt(LOOK_STRUCTURES, x, y)
          .some((s) => OBSTACLE_OBJECT_TYPES.includes(s.structureType));
        if (blocked) continue;
        tiles.push(new RoomPosition(x, y, creep.room.name));
      }
    }
    return tiles;
  }

  // The lure bias (#130): a tile→score function (higher = more "toward home"), used only
  // to break ties between equally-safe retreat tiles. At home, bias toward the nearest
  // tower so the guard kites inside tower coverage. In a 1-hop remote, bias toward the
  // home-room exit so a chasing enemy is dragged back toward home (and its tower). From a
  // 2-hop+ room, or when home has no tower yet, there is nothing to lure toward → no bias.
  static lureScorer(creep, colony) {
    const homeRoom = Game.rooms[colony.name];
    const towers = homeRoom
      ? homeRoom.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER })
      : [];
    if (!towers.length) return () => 0;
    if (creep.room.name === colony.name) {
      const tower = creep.pos.findClosestByRange(towers);
      return (tile) => -tile.getRangeTo(tower); // nearer the tower scores higher
    }
    if (Game.map.getRoomLinearDistance(colony.name, creep.room.name) !== 1) return () => 0;
    return this.edgeBias(Game.map.findExit(creep.room.name, colony.name));
  }

  // Map a FIND_EXIT_* side (the home-ward direction) to a tile→score that grows toward
  // that edge, so a kiting guard drifts home. Unknown/no-path exit → flat zero (no lure).
  static edgeBias(exit) {
    switch (exit) {
      case FIND_EXIT_LEFT:
        return (tile) => 49 - tile.x;
      case FIND_EXIT_RIGHT:
        return (tile) => tile.x;
      case FIND_EXIT_TOP:
        return (tile) => 49 - tile.y;
      case FIND_EXIT_BOTTOM:
        return (tile) => tile.y;
      default:
        return () => 0;
    }
  }
}
