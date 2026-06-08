import { CombatBehaviour } from "./CombatBehaviour.js";
import { kiteStep, closeTo } from "./atoms/acts.js";

// ============================================================================
//  Reposition (#280) — the MOVE-channel leaf of the kite tree. Hold the body's ideal distance to the
//  fight, WITHOUT attacking (Shoot owns the trigger): a ranged unit KITES (flee a tile when a threat
//  breaches reach / close when the target drifts out / hold at reach), a melee unit CLOSES to range 1
//  (it kills by contact, it does not kite), and a WEAPONLESS unit (a medic caught in selfDefense) only
//  HOLDS distance — flees a threat in reach, never closes on one it can't hit (#281 review). Threats +
//  target come from `ctx`. A sibling of Shoot under `compound`, so the unit fires and repositions in one tick.
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
    // Ranged kites (closes if the focus drifts out); weaponless only flees — never approaches a threat.
    kiteStep(creep, target, threats, { canEngage: creep.getActiveBodyparts(RANGED_ATTACK) > 0 });
    return true;
  }
}
