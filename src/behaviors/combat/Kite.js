import { CombatBehaviour } from "./CombatBehaviour.js";
import { Shoot } from "./Shoot.js";
import { Reposition } from "./Reposition.js";
import { GroupHeal } from "./GroupHeal.js";
import { compound } from "../combinators.js";
import { armedOf } from "./atoms/selectors.js";

// ============================================================================
//  Kite (#188/#189) — the ranged-combat conduct atom: stay at reach, shoot, step back the instant the
//  enemy closes, close if it drifts out. The warband-flavour combat nucleus (no garrison, no retaliation
//  bookkeeping — that's Engage's role-flavour). Owns only the nearest-armed target policy; the execution is
//  the shared kite tree `compound(Shoot, Reposition, GroupHeal)` — fire ⊕ reposition ⊕ heal in one tick.
//
//  Returns the atom contract bool: true if there were hostiles, false if clear — so `fallback(Kite,
//  Regroup)` kites on contact and regroups when there's nothing to fight.
//
//  `ctx` (optional): ctx.threats (else self-scan), ctx.target (else armed-nearest). The override lets a
//  composing behavior reuse the kite mechanics on a chosen shared target.
// ============================================================================
export class Kite extends CombatBehaviour {
  static run(creep, colony, ctx) {
    const hostiles = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (!hostiles.length) return false; // room clear → caller's fallback runs the next node

    const armed = armedOf(hostiles);
    const engageable = armed.length ? armed : hostiles;
    const target = ctx?.target ?? creep.pos.findClosestByRange(engageable);

    this.note(creep, "kite:fire");
    return compound(creep, colony, [Shoot, Reposition, GroupHeal], {
      target,
      threats: engageable,
      crowd: hostiles.length > 1,
    });
  }
}
