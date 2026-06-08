import { CombatBehaviour } from "./CombatBehaviour.js";
import { shoot, meleeStrike } from "./atoms/acts.js";

// ============================================================================
//  Shoot (#280) — the ATTACK-channel leaf of the kite tree. Fire the resolved focus target BY BODY,
//  WITHOUT moving (Reposition owns the feet): ranged shoots anything in reach (mass-blast in a crowd),
//  melee strikes only an adjacent target. A sibling of Reposition under `compound`, so the shot ALWAYS
//  lands the same tick we step back — the retreat never gates the damage (#280). The target comes from
//  `ctx` (the composing node's target policy); this leaf never self-selects.
// ============================================================================
export class Shoot extends CombatBehaviour {
  static run(creep, _colony, ctx) {
    const target = ctx?.target;
    if (!target) return false;
    if (creep.getActiveBodyparts(ATTACK) > 0) return meleeStrike(creep, target); // hit if adjacent, no chase
    shoot(creep, target, ctx?.crowd);
    return true;
  }
}
