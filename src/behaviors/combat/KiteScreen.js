import { CombatBehaviour } from "./CombatBehaviour.js";
import { Kite } from "./Kite.js";
import { Regroup } from "./Regroup.js";
import { fallback } from "../combinators.js";

// ============================================================================
//  KiteScreen — the ranged ATTACKER archetype: shoot + kite the enemy, screening
//  the squad's softer members; with no threats present, regroup toward the warband.
//
//  Now a COMPOSITE (#188): `fallback(Kite, Regroup)`. Kite engages and returns true
//  on contact; with the room clear it returns false and the fallback drops to
//  Regroup. This is the first proof of the composable-behavior contract — the
//  conduct is COMPOSED from atoms instead of reaching into the Guard role, and the
//  extracted Kite/Regroup atoms are reused by the rest of the combat catalog next.
//  (See thoughts/shared/notes/2026-06-06/composable-behaviors-and-magnet-field-movement.md)
//
//  Assignment: memory.warband — the group tag Regroup converges toward (set by #174).
// ============================================================================
export class KiteScreen extends CombatBehaviour {
  static run(creep, colony) {
    return fallback(creep, colony, [Kite, Regroup]);
  }
}
