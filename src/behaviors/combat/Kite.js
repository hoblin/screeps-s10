import { Behavior } from "../Behavior.js";
import { Threat } from "../../lib/Threat.js";
import { Movement, KITE_RANGE } from "../../lib/Movement.js";

// ============================================================================
//  Kite (#188) — the ranged-combat ATOM and the highest-reuse brick: stay at
//  RANGED_ATTACK reach, shoot, step back the instant the enemy closes inside it,
//  close the gap if it drifts out. Lifted canonically from the old Guard ranged
//  nucleus so behaviors no longer reach into the Guard role for combat.
//
//  Returns the atom contract boolean: TRUE if there were hostiles (we engaged),
//  FALSE if the room is clear — so `fallback(Kite, Regroup)` kites on contact and
//  falls through to regroup when there's nothing to fight, with no conditionals in
//  the composite.
//
//  `ctx` (optional, from a parent composite):
//   • ctx.threats — the hostile list to consider (else self-scan the room)
//   • ctx.target  — the single creep to fire on (else armed-first, then nearest)
//  The override is what lets a future focusFire reuse Kite to burst ONE shared
//  target instead of each member's own nearest.
// ============================================================================
export class Kite extends Behavior {
  static run(creep, _colony, ctx) {
    // Self-heal every tick when hurt — mirrors the old Guard.engage top-of-call heal, so a
    // KiteScreen body's lone HEAL part still sustains it even on a regroup tick (this runs
    // before the no-hostiles early-return). #189 may lift this into a composing `engage` atom.
    if (creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);

    const threats = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (!threats.length) return false; // room clear → let the caller's fallback run the next node

    // Target the ARMED hostiles first (the real threat); fall back to the nearest of anything
    // (harmless mopup) when none are armed. A caller may override with an explicit ctx.target.
    const armed = threats.filter((h) => Threat.combatPower(h) > 0);
    const engageable = armed.length ? armed : threats;
    const target = ctx?.target ?? creep.pos.findClosestByRange(engageable);

    this.note(creep, "kite:fire");
    const range = creep.pos.getRangeTo(target);
    // Mass-attack only at point-blank with a crowd (every adjacent enemy takes a hit); otherwise
    // a single aimed shot from reach. Past KITE_RANGE no shot fires — we're closing this tick.
    if (threats.length > 1 && range <= 1) creep.rangedMassAttack();
    else if (range <= KITE_RANGE) creep.rangedAttack(target);
    // Reposition: too close → flee a tile (PathFinder away from EVERY threat, never into a
    // corner/exit); too far → close to reach. At exactly KITE_RANGE we hold and keep firing.
    if (range < KITE_RANGE) Movement.kiteAway(creep, engageable);
    else if (range > KITE_RANGE) creep.travelTo(target, { range: KITE_RANGE });
    return true;
  }
}
