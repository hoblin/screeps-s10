import { bodyFromTemplate } from "./BodyGenerator.js";

// ============================================================================
//  CombatBody (#189) — shared combat body-sizing, lifted off the Guard role so the
//  whole combat layer (the Guard role, the Behavior base that bodies combatants, and
//  the hunter spawn) sizes bodies from ONE place instead of reaching into Guard. Type
//  is rock-paper-scissors to the enemy profile; SIZE scales with the spawn budget.
// ============================================================================

const MELEE_MAX = 9; // max [ATTACK,MOVE] repeats (melee path: core-clearing)
const RANGED_MAX = 6; // max [RANGED_ATTACK,MOVE] repeats on the ranged body
const HEAL_MAX = 6; // max [HEAL,MOVE] repeats on the dedicated-medic body
const ANTICORE_MAX = 25; // max [ATTACK,MOVE] repeats for a core-buster (~25 ATTACK = 750 dmg/tick →
// ~134 ticks to grind a 100k-HP L0 core; two halve it). Budget-capped on smaller colonies.
const MOVE_BUFFER = 0.4; // fraction of MOVE placed as a LEADING block on the kite body — cheap damage
// sponge (the cheapest part dies first, #280) + swamp speed; the rest is interleaved with the weapons.

// Which counter to field for an enemy part-profile. Any MOBILE combat (ranged or melee)
// → "ranged" (kites melee, mirrors+outlasts ranged; melee can't catch an equal-speed
// kiter in the open). Only a threat with no mobile combat (an invader core) gets cheap
// "melee" burst. Defaults to "ranged" when the profile is unknown.
export function counterType(profile) {
  if (!profile) return "ranged";
  return profile.ranged > 0 || profile.attack > 0 ? "ranged" : "melee";
}

// Dynamic combat body: type from the enemy profile, size from the spawn budget. Melee is cheap
// [ATTACK,MOVE] burst for a threat that can't kite back. Ranged is a kite body — sized by the proven
// template then reordered canonically: MOVE front-buffer (cheap armor + swamp speed), RANGED core, HEAL
// LAST so it survives front-first destruction and keeps sustaining while damaged (#280).
export function combatBody(energyBudget, profile) {
  if (counterType(profile) === "melee") {
    return bodyFromTemplate([ATTACK, MOVE], { extra: [ATTACK, MOVE], max: MELEE_MAX, energy: energyBudget });
  }
  const raw = bodyFromTemplate([RANGED_ATTACK, MOVE, HEAL, MOVE], {
    extra: [RANGED_ATTACK, MOVE],
    max: RANGED_MAX,
    energy: energyBudget,
  });
  return orderKiteBody(raw, energyBudget);
}

// The dedicated-medic body — pure [HEAL,MOVE], 1:1 for full road speed with its escort. Single-sourced
// here so the mission roster and the HealGroup behaviour size the same medic. Below the [HEAL,MOVE] floor
// bodyFromTemplate would fall back to a worker body, so return [] and let the overlord skip the slot — a
// HEAL-less "medic" is worse than none (same never-useless guard as antiCoreBody, #281 review).
export function healerBody(energyBudget) {
  if (energyBudget < BODYPART_COST[HEAL] + BODYPART_COST[MOVE]) return [];
  return bodyFromTemplate([HEAL, MOVE], { extra: [HEAL, MOVE], max: HEAL_MAX, energy: energyBudget });
}

// Reorder a sized ranged body into the kite layout — MOVE front-buffer, RANGED interleaved with the rest
// of the MOVE, HEAL LAST — and spend leftover budget on a little extra MOVE (swamp speed + a deeper sponge,
// capped a few over the 1:1 core). Front-first destruction then eats cheap MOVE before the weapons and the
// HEAL, so a damaged kiter keeps both its reach and its sustain. A worker-fallback body (no RANGED, budget
// below the template) is returned untouched.
function orderKiteBody(body, energyBudget) {
  const count = (part) => body.reduce((n, p) => n + (p === part ? 1 : 0), 0);
  const ranged = count(RANGED_ATTACK);
  const heal = count(HEAL);
  if (!ranged) return body; // worker fallback — not a combat body, leave as-is
  let move = count(MOVE);

  let spare = energyBudget - body.reduce((sum, p) => sum + BODYPART_COST[p], 0);
  while (spare >= BODYPART_COST[MOVE] && move + ranged + heal < 50 && move < ranged + heal + 4) {
    move++;
    spare -= BODYPART_COST[MOVE];
  }

  const front = Math.ceil(move * MOVE_BUFFER);
  const ordered = [];
  for (let i = 0; i < front; i++) ordered.push(MOVE);
  let rest = move - front;
  for (let i = 0; i < ranged; i++) {
    ordered.push(RANGED_ATTACK);
    if (rest > 0) {
      ordered.push(MOVE);
      rest--;
    }
  }
  while (rest > 0) {
    ordered.push(MOVE);
    rest--;
  }
  for (let i = 0; i < heal; i++) ordered.push(HEAL);
  return ordered;
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
