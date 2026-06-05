import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

const KITE_RANGE = 3; // RANGED_ATTACK reach — a ranged guard fights from exactly here
const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: future core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body
const GUARD_PARK_DELAY = 5; // ticks to hold the spot after the last hostile contact before walking
// back to park — long enough to shoot a harasser that ducks across the border and returns (#160).

// ============================================================================
//  Guard — the colony's combat creep: clears a contested remote so the economy
//  can flow back (#118, Levels 2-3 of the threat ladder).
//
//  A dumb executor (per the domain-controller doctrine): GuardOverlord decides
//  WHICH hot room is winnable and stamps it (+ the body TYPE) at spawn; this role
//  travels there, kills the armed threat, mops up the harmless stragglers (scouts /
//  reservers), then GARRISONS the room — parks on its controller and holds for life,
//  re-engaging anything that wanders in (#128). After a fight it holds the spot a few ticks
//  before walking back to park, so a harasser that ducks across the border and returns is shot
//  on the spot rather than re-chased from the controller (#160). It never recycles on clear (a
//  stationed guard answers the next poke with no rebuild and keeps the room's intel
//  fresh via vision); only the overlord releasing it (room left the footprint) sends
//  it home. Bailing on a false alarm happens only in transit (room cooled en route).
//
//  Retaliation (#140): once its room cools, the OVERLORD may redirect this idle guard to deny the
//  attacker's tower-free remote — it stamps the enemy room as `guardRoom` + a `retaliationMission`.
//  The guard then travels and engages/holds there exactly as it garrisons home, denying his economy
//  (the in-transit empty-bail is suppressed for the mission). The armed attacker's owner is
//  remembered here in `engage` as `creep.memory.foughtOwner`.
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
      // Bail on a confirmed-empty room in transit — but NOT on a retaliation mission (#140): a
      // momentarily-empty enemy remote isn't a false alarm, it's the target; the overlord owns
      // when that mission ends (recall / tower / he left).
      const seen = Game.rooms[room];
      if (seen && !creep.memory.retaliationMission && seen.find(FIND_HOSTILE_CREEPS).length === 0) {
        creep.memory.guardRoom = null;
        return this.recycleAtHome(creep, colony);
      }
      this.note(creep, "guard:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return;
    }

    // On station. Fight any hostiles (armed first, then mop harmless stragglers); once the
    // room is clean, garrison the controller and hold for life.
    if (this.engage(creep)) {
      creep.memory.lastEngaged = Game.time; // mark contact for the post-clear hold (#160)
      return;
    }
    // Just cleared: hold the spot for a few ticks before walking back to park (#160), so a
    // harasser that ducked across the border and returns is shot from here instead of re-chased
    // from the controller (the old controller↔border oscillation). A retask/recall exits earlier
    // — it trips the in-transit branch above before this is reached.
    if (this.holding(creep)) {
      this.note(creep, "guard:hold");
      return;
    }
    const ctrl = creep.room.controller;
    if (ctrl && !creep.pos.inRangeTo(ctrl, 1)) {
      this.note(creep, "guard:to-post");
      creep.travelTo(ctrl, { range: 1 });
    } else {
      // Garrison: defend the controller, deny reservers, keep intel fresh. On a retaliation
      // mission (#140) the "controller" is the ATTACKER's — parking there denies HIS remote.
      this.note(creep, creep.memory.retaliationMission ? "guard:deny" : "guard:park");
    }
  }

  // Within the post-engagement hold window (#160): true for the GUARD_PARK_DELAY clear ticks after
  // the last hostile contact. `<=` (not `<`) so a delay of 5 yields a full 5 clear ticks of hold —
  // `lastEngaged` is the LAST contact tick, and the first clear tick is already `now - last == 1`.
  // Keyed off that contact tick (stamped on engage), so it expires on its own and is never
  // refreshed on clear ticks; a never-engaged guard (no lastEngaged) skips the hold and parks
  // immediately on arrival.
  static holding(creep) {
    const last = creep.memory.lastEngaged;
    return last !== undefined && Game.time - last <= GUARD_PARK_DELAY;
  }

  // Heal self and fight the hostiles in the CURRENT room — armed first, then harmless
  // stragglers. Returns true if there were hostiles (we engaged), false if the room is
  // clear. The combat nucleus, free of any room/garrison/follow logic, so both the
  // garrison Guard and the follow Escort (#147) share it.
  static engage(creep) {
    if (creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (!hostiles.length) return false;
    const armed = hostiles.filter((h) => Threat.combatPower(h) > 0);
    const target = creep.pos.findClosestByRange(armed.length ? armed : hostiles);
    // Remember the ARMED attacker's owner so the overlord can deny that player's remote once this
    // room cools (sunk-asset retaliation #140). Harmless scouts/reservers (combatPower 0) don't
    // earn revenge — only a creep we actually had to fight.
    if (armed.length && target.owner) creep.memory.foughtOwner = target.owner.username;

    if (creep.memory.guardType === "melee") {
      this.note(creep, "guard:melee");
      if (creep.attack(target) === ERR_NOT_IN_RANGE) creep.travelTo(target, { range: 1 });
      return true;
    }

    // Ranged: shoot from range 3 and kite — step away if the enemy closes inside 3, close
    // if it's drifting out, so we keep dealing damage while taking little.
    this.note(creep, "guard:ranged");
    const range = creep.pos.getRangeTo(target);
    if (hostiles.length > 1 && range <= 1) creep.rangedMassAttack();
    else if (range <= KITE_RANGE) creep.rangedAttack(target);
    if (range < KITE_RANGE) this.kiteAway(creep, armed.length ? armed : hostiles);
    else if (range > KITE_RANGE) creep.travelTo(target, { range: KITE_RANGE });
    return true;
  }

  // Retreat to restore kite distance WITHOUT self-cornering (#130). The death case was
  // guard_8142 kiting straight into the west edge and freezing. A greedy "best adjacent
  // tile" still self-traps in concave terrain (a swamp/wall pocket) because it only looks
  // one tile ahead — so we flee with a real path search: PathFinder routes AWAY from EVERY
  // threat with full lookahead, stepping around small obstacles and never into a dead end,
  // and shuns swamp via the default terrain cost. The first step is handed to travelTo (not
  // a raw move) so it registers with the traffic resolver and can shove a lower-priority
  // idler out of the retreat rather than be walled in. We re-plan next tick; an empty path
  // (boxed in, or already at range) → hold and keep firing (the ranged shot already fired).
  static kiteAway(creep, threats) {
    const matrix = this.kiteCostMatrix(creep.room); // built once per call, not per callback
    const goals = threats.map((t) => ({ pos: t.pos, range: KITE_RANGE }));
    const { path } = PathFinder.search(creep.pos, goals, {
      flee: true,
      maxRooms: 1,
      roomCallback: () => matrix,
    });
    if (path.length) creep.travelTo(path[0]);
  }

  // Cost matrix for the kite flee search: hard-block the room-exit ring (#119 — never leave
  // the room), every movement-blocking structure (obstacles + hostile ramparts), and every
  // HOSTILE creep (can't be shoved or stepped onto). Friendly creeps are left walkable so
  // the traffic resolver can shove a lower-priority idler aside instead of walling the guard
  // in. Walls come free from terrain; swamp stays costly via the default swampCost.
  static kiteCostMatrix(room) {
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
    return matrix;
  }

  // A structure blocks our movement: any standard obstacle type, plus a rampart we don't
  // own and that isn't public (an enemy rampart is impassable; ours / a public one is not).
  static blocksMovement(structure) {
    if (structure.structureType === STRUCTURE_RAMPART) return !structure.my && !structure.isPublic;
    return OBSTACLE_OBJECT_TYPES.includes(structure.structureType);
  }
}
