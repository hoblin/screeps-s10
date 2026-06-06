import { KITE_RANGE } from "../../../lib/Movement.js";
import { steer, enemyField, separation, APPROACH_RANGE } from "./field.js";

// ============================================================================
//  Combat acts (#189) — the EXECUTION primitives: each takes a creep + an already
//  RESOLVED target/anchor and emits one or more intents. Pure mechanism — no target
//  selection (that's the selectors / the composing behavior's policy) and no
//  telemetry notes (the composing behavior owns its `note` tag). This is the shared
//  "verbs" layer the conduct atoms (Kite/Engage) and the positional behaviors all
//  build on, so the kite/melee/anchor logic lives in exactly one place.
//
//  A creep may emit several non-conflicting intents in one tick (move + rangedAttack
//  + heal), so an act fires its intent and returns — composition is the caller's job.
// ============================================================================

// Heal self when hurt (a HEAL-bearing body); a no-op otherwise. Safe to call every tick.
export function selfHeal(creep) {
  if (creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);
}

// Fire on a target: a mass blast at point-blank when there's a crowd to splash (every
// adjacent enemy takes a hit), else a single aimed shot from within reach. No movement.
export function shoot(creep, target, crowd = false) {
  const range = creep.pos.getRangeTo(target);
  if (crowd && range <= 1) creep.rangedMassAttack();
  else if (range <= KITE_RANGE) creep.rangedAttack(target);
}

// Hold the ideal ranged distance. NAVIGATION vs the micro-dance (#196): while the nearest threat is
// farther than APPROACH_RANGE, APPROACH it by A* (travelTo — paths around walls/geometry, prefers
// roads, has a stuck-counter; restores the old guard's PathFinder approach the greedy field had
// dropped). Once close, the magnet FIELD takes over: each threat a body-derived magnet (offence
// repels, healers attract) plus squad separation — the creep settles at kite range from EVERY threat
// (never caught in a stacked rangedMassAttack), leans onto enemy healers, never backs into a corner.
export function kiteStep(creep, threats) {
  const target = creep.pos.findClosestByRange(threats);
  if (target && creep.pos.getRangeTo(target) > APPROACH_RANGE) {
    creep.travelTo(target, { range: KITE_RANGE });
    return;
  }
  // Close in: field micro, with an A* fallback if the field freezes short of kite range (a wall/corner
  // between us and the target — the field can't detour around it, A* can).
  steer(creep, [...enemyField(threats), ...separation(creep)], { goal: target, goalRange: KITE_RANGE });
}

// Melee: strike if adjacent, else step to range 1. `opts` forwards to travelTo — a
// focus-firing creep passes { priority: 1 } to take the target tile from idlers so the
// squad's burst lands the same tick. (Calling attack() out of range is a harmless no-op,
// so the isNearTo guard is equivalent to the old attack()===ERR_NOT_IN_RANGE idiom.)
export function meleeHit(creep, target, opts = {}) {
  if (creep.pos.isNearTo(target)) creep.attack(target);
  else creep.travelTo(target, { range: 1, ...opts });
}

// Close to within `range` of a target (no attack — the caller fires separately).
export function closeTo(creep, target, range, opts = {}) {
  creep.travelTo(target, { range, ...opts });
}

// Settle at an anchor: travel to within `range` if beyond it, else hold. Returns true if
// it had to move, false if already settled — so the caller can pick its hold-vs-move note.
export function holdAnchor(creep, anchor, range = 1) {
  if (creep.pos.getRangeTo(anchor) > range) {
    creep.travelTo(anchor, { range });
    return true;
  }
  return false;
}
