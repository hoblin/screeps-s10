import { bodyFromTemplate } from "./BodyGenerator.js";

// ============================================================================
//  CombatBody (#189) — shared combat body-sizing, lifted off the Guard role so the
//  whole combat layer (the Guard role, the Behavior base that bodies combatants, and
//  the escort spawn) sizes bodies from ONE place instead of reaching into Guard. Type
//  is rock-paper-scissors to the enemy profile; SIZE scales with the spawn budget.
// ============================================================================

const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body

// Which counter to field for an enemy part-profile. Any MOBILE combat (ranged or melee)
// → "ranged" (kites melee, mirrors+outlasts ranged; melee can't catch an equal-speed
// kiter in the open). Only a threat with no mobile combat (an invader core) gets cheap
// "melee" burst. Defaults to "ranged" when the profile is unknown.
export function counterType(profile) {
  if (!profile) return "ranged";
  return profile.ranged > 0 || profile.attack > 0 ? "ranged" : "melee";
}

// Dynamic combat body: type from the enemy profile, size from the spawn budget. Ranged
// carries one HEAL (self-sustain) + a ~1:1 move-to-part ratio (full speed on roads); melee
// is cheap [ATTACK,MOVE] burst for a threat that can't kite back.
export function combatBody(energyBudget, profile) {
  if (counterType(profile) === "melee") {
    return bodyFromTemplate([ATTACK, MOVE], { extra: [ATTACK, MOVE], max: MELEE_MAX, energy: energyBudget });
  }
  return bodyFromTemplate([RANGED_ATTACK, MOVE, HEAL, MOVE], {
    extra: [RANGED_ATTACK, MOVE],
    max: RANGED_MAX,
    energy: energyBudget,
  });
}
