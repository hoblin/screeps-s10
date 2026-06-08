import { Threat } from "../lib/Threat.js";
import { combatBody, healerBody } from "../lib/CombatBody.js";

// Defenders ONE spawn can sustain against a single threat alongside the economy (a combat body lives
// ~1500 ticks and spawns in tens of ticks; ~5 is a conservative share of one spawn). The fielded group is
// bounded by `spawns.length × this` — it SCALES with the colony's spawn capacity, not a flat magic cap
// (#268). When even the sustainable group can't win, that is the safe-mode / escalation seam (#259), not
// "field a fixed few and hope".
export const SUSTAINABLE_PER_SPAWN = 5;

// The guard behaviour set every defence/clear mission stamps: garrison a post (holdPoint), fight back
// en route (selfDefense), chase the attacker's remote once the post cools (raidRoom — the retaliation
// carrier), park after a fight (holdGround). Conduct lives in these behaviours; missions only stamp the set.
export const DEFENSE_BEHAVIORS = { default: "holdPoint", nodes: ["selfDefense", "raidRoom", "holdGround"] };

// The dedicated-MEDIC set: tail the armed element and heal the most-hurt squadmate (healGroup); flee, don't
// fight, when caught alone in transit (selfDefense → a weaponless body just kites away). The medic shares
// the skirmishers' memory.mission, so it follows + heals its mission-mates with no extra wiring (#280).
export const MEDIC_BEHAVIORS = { default: "healGroup", nodes: ["selfDefense"] };

// Medics per skirmisher in a fielded group — the old warband's 3:2 shape (#280): dedicated sustain is what
// lets a stacked group out-live a healing enemy instead of being picked off one by one. Conduct lives in
// the behaviours; the roster only sets the body + count + set.
const MEDIC_RATIO = 0.5;

// ============================================================================
//  Mission (#259) — the abstract base of the operational military domain. A mission owns its own force
//  (a ROSTER of unit-types × counts) and its own lifecycle; the OperationalMilitaryOverlord is the
//  type-agnostic backbone that fields the roster by count-coverage and dispatches members to it.
//
//  The base holds only what is common to EVERY mission: identity (key), the muster target (size/rallied),
//  and the shared threat-counter roster helper. The two STAGE-SHAPES live one level down — GarrisonMission
//  (home/child defence: instant-muster, replace=ON, hold in place) and RemoteMission (muster → deploy as a
//  group → execute, no mid-flight replacement). Concrete missions (DefendHome, DefendChild, ClearRemote,
//  BustCore) extend those and supply only composition() + recognition + any go/no-go gate. CONDUCT is never
//  re-coded in a mission — it stamps memory.behaviors and the behaviour layer runs the tactics.
// ============================================================================
export class Mission {
  constructor(colony, room) {
    this.colony = colony;
    this.room = room;
  }

  get home() {
    return this.colony.name;
  }

  // Stable per-mission identity (type + target room) — stamped as memory.mission on each member so the
  // overlord groups them and counts coverage per mission. Concrete subclasses set this.type.
  get key() {
    return `${this.type}:${this.room}`;
  }

  // Total creeps the full roster needs — the muster target.
  size() {
    return this.roster().reduce((n, slot) => n + slot.count, 0);
  }

  // Is the full group spawned and ready (the muster→deploy gate)?
  rallied(members) {
    return members.filter((creep) => !creep.spawning).length >= this.size();
  }

  // Shared threat-counter roster: one budget-scaled counter body (the existing combatBody, type chosen by
  // the enemy profile), fielded in enough copies to win — sized against BOTH the enemy's offence AND its
  // HEALING (#268). A healer makes a group un-killable below a DPS floor, so a heal-blind power gate would
  // under-size against a healed force; `need` takes the max of the power term (threatOf — incl. towers/cores)
  // and the out-heal term (enemyHeal), each with the 1.5× margin.
  //   • survivalFloor (home): ALWAYS field, bounded only by what we can sustain (towers carry the overflow; a
  //     need beyond sustainable is the safe-mode escalation, #259).
  //   • otherwise (child/remote): field the winning group only if we can SUSTAIN it, else NOTHING — don't
  //     feed a losing fight (pull/wait). `count > 0` is the single "winnable as a sustainable group" gate the
  //     recognisers read.
  // A null profile (a cold proactive guard) yields the default body and count 1. A weaponless body (power 0,
  // a too-poor budget falling back to a worker) yields count 0 → no spawn (a defender is armed or not born,
  // #234).
  counterRoster(profile, behaviors, { survivalFloor = false } = {}) {
    const budget = this.colony.spawnEnergyBudget();
    const body = combatBody(budget, profile);
    const power = Threat.guardCombatPower(body);
    if (!power) return [{ body, count: 0, behaviors }];
    const need = Math.max(
      Math.ceil((Threat.threatOf(this.room) * Threat.WIN_MARGIN) / power),
      Math.ceil((Threat.enemyHeal(this.room) * Threat.WIN_MARGIN) / power),
      1
    );
    const sustainable = this.colony.spawns.length * SUSTAINABLE_PER_SPAWN;
    const count = survivalFloor ? Math.min(need, sustainable) : need <= sustainable ? need : 0;

    const slots = [{ body, count, behaviors }];
    // Field dedicated medics ALONGSIDE the skirmishers (the 3:2 warband shape) once the group is ≥2 — the
    // sustain that wins the heal race against a healing enemy. Medics come OUT of the same `sustainable`
    // budget (don't blow the documented bound, #281 review): at the ceiling the colony can't afford extra
    // bodies, so a maxed skirmisher group (home under a big threat — towers carry it) fields none, while a
    // remote op (count < sustainable) gets its escort. A lone skirmisher (count 1, trivial threat) needs none.
    // Medics share the mission tag, so they follow + heal their mission-mates unwired.
    const wantMedics = count >= 2 ? Math.max(1, Math.round(count * MEDIC_RATIO)) : 0;
    const medics = Math.min(wantMedics, Math.max(0, sustainable - count));
    const medicBody = healerBody(budget);
    if (medics > 0 && medicBody.length) slots.push({ body: medicBody, count: medics, behaviors: MEDIC_BEHAVIORS });
    return slots;
  }
}
