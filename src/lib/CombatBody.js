import { bodyFromTemplate } from "./BodyGenerator.js";

// ============================================================================
//  CombatBody (#189) — shared combat body-sizing, lifted off the Guard role so the
//  whole combat layer (the Guard role, the Behavior base that bodies combatants, and
//  the hunter spawn) sizes bodies from ONE place instead of reaching into Guard. Type
//  is rock-paper-scissors to the enemy profile; SIZE scales with the spawn budget.
// ============================================================================

const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body
const ANTICORE_MAX = 25; // max [ATTACK,MOVE] repeats for a core-buster (~25 ATTACK = 750 dmg/tick →
// ~134 ticks to grind a 100k-HP L0 core; two halve it). Budget-capped on smaller colonies.

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

// Anti-core composition (#259) — a cheap pure-ATTACK burst to grind down an invader core. An L0 remote
// core has NO tower and NO defenders, so nothing fires back: no HEAL, no TOUGH, just ATTACK + 1:1 MOVE
// (full speed to reach the remote, then stand and grind). The first of the TYPED compositions counterType
// grows into — kite (RANGED+HEAL), pair (attacker+healer) and tower-assisted land in #250's threat-matched
// sizing. Sized down to the spawn budget like every combat body.
export function antiCoreBody(energyBudget) {
  // Never field an UNARMED buster: if the budget can't afford even the [ATTACK,MOVE] base, return an empty
  // body so the spawn is skipped — bodyFromTemplate would otherwise fall back to the generic worker body.
  // (The systemic never-weaponless guarantee across ALL combat sizers is #234; this just keeps the new
  // anti-core path from introducing its own weaponless case.)
  if (energyBudget < BODYPART_COST[ATTACK] + BODYPART_COST[MOVE]) return [];
  return bodyFromTemplate([ATTACK, MOVE], { extra: [ATTACK, MOVE], max: ANTICORE_MAX, energy: energyBudget });
}
