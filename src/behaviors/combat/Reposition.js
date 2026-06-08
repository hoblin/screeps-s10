import { CombatBehaviour } from "./CombatBehaviour.js";
import { kiteStep, closeTo } from "./atoms/acts.js";

// ============================================================================
//  Reposition (#280) — the MOVE-channel leaf of the kite tree. Hold the body's ideal distance to the
//  fight, WITHOUT attacking (Shoot owns the trigger): a ranged unit KITES (flee a tile when a threat
//  breaches reach / close when the target drifts out / hold at reach), a melee unit CLOSES to range 1
//  (it kills by contact, it does not kite). Threats + target come from `ctx`. A sibling of Shoot under
//  `compound`, so the unit fires and repositions in the same tick.
// ============================================================================
export class Reposition extends CombatBehaviour {
  static run(creep, _colony, ctx) {
    const target = ctx?.target;
    if (creep.getActiveBodyparts(ATTACK) > 0) {
      if (target) closeTo(creep, target, 1, ctx?.meleeOpts); // melee: step into reach (the strike is Shoot's)
      return !!target;
    }
    const threats = ctx?.threats;
    if (!threats || !threats.length) return false;
    kiteStep(creep, target, threats); // ranged: flee inside reach / close if out / hold — off the nearest threat
    return true;
  }
}
