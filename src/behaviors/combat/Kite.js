import { CombatBehaviour } from "./CombatBehaviour.js";
import { groupHeal, shoot, kiteStep } from "./atoms/acts.js";
import { armedOf } from "./atoms/selectors.js";

// ============================================================================
//  Kite (#188/#189) — the ranged-combat conduct atom: stay at reach, shoot, step back
//  the instant the enemy closes, close if it drifts out. The warband-flavour combat
//  nucleus (no garrison, no retaliation bookkeeping — that's Engage's role-flavour).
//  Composed from the shared acts so the kite mechanics live in exactly one place.
//
//  Returns the atom contract bool: true if there were hostiles, false if clear — so
//  `fallback(Kite, Regroup)` kites on contact and regroups when there's nothing to fight.
//
//  `ctx` (optional): ctx.threats (else self-scan), ctx.target (else armed-nearest). The
//  override lets FocusFire/others reuse the kite mechanics on a chosen shared target.
// ============================================================================
export class Kite extends CombatBehaviour {
  static run(creep, _colony, ctx) {
    groupHeal(creep);
    const threats = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (!threats.length) return false; // room clear → caller's fallback runs the next node

    const armed = armedOf(threats);
    const engageable = armed.length ? armed : threats;
    const target = ctx?.target ?? creep.pos.findClosestByRange(engageable);

    this.note(creep, "kite:fire");
    shoot(creep, target, threats.length > 1);
    kiteStep(creep, engageable);
    return true;
  }
}
