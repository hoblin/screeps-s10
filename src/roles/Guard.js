import { Role } from "./Role.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

const KITE_RANGE = 3; // RANGED_ATTACK reach — a ranged guard fights from exactly here
const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: future core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body
// Screeps movement directions (1-8) → tile offset, for the kite step.
const DIR_OFFSET = {
  1: [0, -1], 2: [1, -1], 3: [1, 0], 4: [1, 1],
  5: [0, 1], 6: [-1, 1], 7: [-1, 0], 8: [-1, -1],
};

// ============================================================================
//  Guard — the colony's combat creep: clears a contested remote so the economy
//  can flow back (#118, Levels 2-3 of the threat ladder).
//
//  A dumb executor (per the domain-controller doctrine): GuardOverlord decides
//  WHICH hot room is winnable and stamps it (+ the body TYPE) at spawn; this role
//  just travels there and fights. It recycles the moment the room is no longer hot
//  (cleared / cooled) — once our vision drops the intel threat to 0, the whole
//  remote stack flows back on its own, so the guard's only job is to win the fight.
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
    if (!room) return this.recycleAtHome(creep, colony); // no assignment → done

    // The win condition: the room is no longer hot (we cleared it, or it cooled in
    // transit). Recycle — the remote stack resumes on its own via the intel.
    if (!Threat.isHot(room)) {
      creep.memory.guardRoom = null;
      return this.recycleAtHome(creep, colony);
    }

    if (creep.room.name !== room) {
      this.note(creep, "guard:to-room");
      creep.travelTo(new RoomPosition(25, 25, room), { range: 20 });
      return;
    }

    // In the contested room: engage the dangerous hostiles (ignore harmless scouts,
    // same combatPower test as the intel). If none are visible this tick, hold —
    // next tick our vision drops the intel and the top guard recycles us.
    const targets = creep.room
      .find(FIND_HOSTILE_CREEPS)
      .filter((h) => Threat.combatPower(h) > 0);
    if (creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);
    if (!targets.length) {
      this.note(creep, "guard:hold");
      return;
    }
    const target = creep.pos.findClosestByRange(targets);

    if (creep.memory.guardType === "melee") {
      this.note(creep, "guard:melee");
      if (creep.attack(target) === ERR_NOT_IN_RANGE) creep.travelTo(target, { range: 1 });
      return;
    }

    // Ranged: shoot from range 3 and kite — step away if the enemy closes inside 3,
    // close if it's drifting out, so we keep dealing damage while taking little.
    this.note(creep, "guard:ranged");
    const range = creep.pos.getRangeTo(target);
    if (targets.length > 1 && range <= 1) creep.rangedMassAttack();
    else if (range <= KITE_RANGE) creep.rangedAttack(target);
    if (range < KITE_RANGE) {
      // Step away to restore kite distance. Screeps dirs are 1-8; +4 (mod 8) flips to
      // the opposite. Only retreat onto a walkable INTERIOR tile — never onto a wall
      // (wasted) or a room-exit tile (would leave the room); else hold and keep firing.
      const away = ((creep.pos.getDirectionTo(target) + 3) % 8) + 1;
      const [dx, dy] = DIR_OFFSET[away];
      const nx = creep.pos.x + dx;
      const ny = creep.pos.y + dy;
      if (nx > 0 && nx < 49 && ny > 0 && ny < 49 && creep.room.getTerrain().get(nx, ny) !== TERRAIN_MASK_WALL) {
        creep.move(away);
      }
    } else if (range > KITE_RANGE) {
      creep.travelTo(target, { range: KITE_RANGE });
    }
  }
}
