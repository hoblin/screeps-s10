import { KITE_RANGE } from "../../../lib/Movement.js";
import { towerFreeRoute } from "../../../lib/Routing.js";
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

// Cross-room transit that ROUTES AROUND danger it can't beat. Picks the next hop of a safe corridor
// toward `room` and heads to its centre — avoiding towered rooms and UNWINNABLE hot rooms, but passing
// THROUGH a winnable hot room (clearing it in passing, assessed against this creep's body). Stateless —
// recomputed each tick, so it always walks the currently-safe corridor one room at a time (a room going
// hot/cleared mid-transit reroutes next tick). Returns true if it has a leg to walk, false if already
// there OR no safe corridor exists (the caller decides what a trapped unit does — hold, pick another
// target). Replaces the hand-rolled `travelTo(new RoomPosition(25,25,room),{range:20})` blind transit (#197).
export function travelToRoom(creep, room, { range = 20, allowUnscouted = false } = {}) {
  if (creep.room.name === room) return false; // already in the room — transit done
  // `clearer: creep` lets a winnable hot leg stay on-route (we clear it in passing); judged via winnableBy.
  const route = towerFreeRoute(creep.room.name, room, { allowUnscouted, avoidHot: true, clearer: creep });
  if (!route) return false; // no safe corridor — trapped; caller's fallback handles it
  const next = route.length ? route[0].room : room; // first hop (or the dest if adjacent)
  creep.travelTo(new RoomPosition(25, 25, next), { range });
  return true;
}

// Damage a target by body, closing to reach — NO kite. For a target to kill outright rather than
// fear: a structure (can't move/flee) or a creep you out-range. Melee steps in and hits; ranged
// closes to KITE_RANGE then fires. Self-heals each tick (a HEAL body soaks incidental damage).
// The non-kiting counterpart to `skirmish` — reused by raidRoom's raze.
export function strike(creep, target) {
  selfHeal(creep);
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
