import { KITE_RANGE } from "../../../lib/Movement.js";
import { steer, enemyField, separation, APPROACH_RANGE } from "./field.js";
import { mostHurtAlly } from "./selectors.js";

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

// Pool the squad's heal (#276): mend the most-hurt friendly in range (INCLUDING self), so a unit with
// spare HEAL tops up whoever's taking fire rather than only itself — even one shooter + the rest healing it
// out-sustains the enemy. heal at range 1 (full 12/part), rangedHeal at 2-3 (4/part). NO movement (the
// combat act owns positioning); the heal resolves the same tick as incoming damage, pre-absorbing the hit.
// A no-op without HEAL parts or with nobody hurt in range. (Self is in the in-range pool — covers self-heal.)
export function groupHeal(creep) {
  if (creep.getActiveBodyparts(HEAL) === 0) return;
  const hurt = mostHurtAlly(creep, 3);
  if (!hurt) return;
  if (creep.pos.isNearTo(hurt)) creep.heal(hurt);
  else creep.rangedHeal(hurt);
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

// Melee strike WITHOUT moving — hit the target if it's already adjacent, else a no-op. The melee
// analog of `shoot` (fire-in-reach, never chase): a hold/denial body strikes an intruder that walks
// into reach but never abandons its ground to chase one. Returns true if the hit landed, so the
// caller can branch (tag its note, skip its own approach).
export function meleeStrike(creep, target) {
  if (creep.pos.isNearTo(target)) {
    creep.attack(target);
    return true;
  }
  return false;
}

// Melee: strike if adjacent, else step to range 1. `opts` forwards to travelTo — a
// focus-firing creep passes { priority: 1 } to take the target tile from idlers so the
// squad's burst lands the same tick.
export function meleeHit(creep, target, opts = {}) {
  if (meleeStrike(creep, target)) return;
  creep.travelTo(target, { range: 1, ...opts });
}

// Close to within `range` of a target (no attack — the caller fires separately).
export function closeTo(creep, target, range, opts = {}) {
  creep.travelTo(target, { range, ...opts });
}

// Damage a target by body, closing to reach — NO kite. For a target to kill outright rather than
// fear: a structure (can't move/flee) or a creep you out-range. Melee steps in and hits; ranged
// closes to KITE_RANGE then fires. Pools heal each tick (a HEAL body mends itself or a hurt mate in reach).
// The non-kiting counterpart to `skirmish` — reused by raidRoom's raze.
export function strike(creep, target) {
  groupHeal(creep);
  if (creep.getActiveBodyparts(ATTACK) > 0) {
    meleeHit(creep, target);
    return;
  }
  if (creep.pos.getRangeTo(target) > KITE_RANGE) closeTo(creep, target, KITE_RANGE);
  shoot(creep, target);
}

// Fight a resolved target by body while KITING — the move-and-shoot sibling of `strike`'s
// stand-and-kill, for an enemy that can hit back. Melee closes and strikes; ranged shoots then
// kites away from `threats` (settling at range from EVERY threat, never caught in stacked fire).
// Returns "melee"/"ranged" so the composing behavior tags its own note. `opts.crowd` mass-blasts at
// point-blank; `opts.meleeOpts` forwards to the melee approach (e.g. { priority: 1 } to take the
// target tile so a squad's burst lands the same tick). The shared body-dispatch for Engage/FocusFire.
export function skirmish(creep, target, threats, { crowd = false, meleeOpts } = {}) {
  if (creep.getActiveBodyparts(ATTACK) > 0) {
    meleeHit(creep, target, meleeOpts);
    return "melee";
  }
  shoot(creep, target, crowd);
  kiteStep(creep, threats);
  return "ranged";
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
