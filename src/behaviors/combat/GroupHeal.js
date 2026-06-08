import { CombatBehaviour } from "./CombatBehaviour.js";
import { groupHeal } from "./atoms/acts.js";

// ============================================================================
//  GroupHeal (#280) — the HEAL-channel leaf. Pool this unit's heal onto the most-hurt squadmate in range
//  (self included), no movement — heal at range 1 (full), rangedHeal at 2-3. Shared by every HEAL-bearing
//  unit: a skirmisher tops up whoever's taking fire, a dedicated medic mends the squad. Fired every combat
//  tick via `compound`, so the heal resolves the SAME tick as the incoming hit (pre-absorb). Squad =
//  warband||mission, so a mission-tagged autonomous defender still mends its mission-mates.
// ============================================================================
export class GroupHeal extends CombatBehaviour {
  static run(creep) {
    return groupHeal(creep);
  }
}
