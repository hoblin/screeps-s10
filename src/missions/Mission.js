import { Threat } from "../lib/Threat.js";
import { combatBody } from "../lib/CombatBody.js";

// Max defenders fielded against ONE threat — the 1.5× margin plus three bodies covers an NPC raid; precise
// heal-aware out-DPS sizing is #250. Caps spawn drain on a single hot room.
export const DEFENSE_COUNT_CAP = 3;

// The guard behaviour set every defence/clear mission stamps: garrison a post (holdPoint), fight back
// en route (selfDefense), chase the attacker's remote once the post cools (raidRoom — the retaliation
// carrier), park after a fight (holdGround). Conduct lives in these behaviours; missions only stamp the set.
export const DEFENSE_BEHAVIORS = { default: "holdPoint", nodes: ["selfDefense", "raidRoom", "holdGround"] };

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
  // the enemy profile), fielded in enough copies to beat the room's threat scalar with the 1.5× margin.
  // One body for a normal threat (= the old single guard, no regression); a sized GROUP only when one
  // max-body can't win, capped. A null profile (a cold proactive guard) yields the default body and count 1.
  // An unaffordable budget yields an empty body → the overlord skips the spawn (a defender is armed or not
  // born, #234). Heal-aware out-DPS sizing (the enemyHeal term of the doctrine formula) stays #250.
  counterRoster(profile, behaviors) {
    const body = combatBody(this.colony.spawnEnergyBudget(), profile);
    const power = Threat.guardCombatPower(body);
    if (!power) return [{ body, count: 0, behaviors }];
    const need = Math.ceil((Threat.threatOf(this.room) * Threat.WIN_MARGIN) / power);
    return [{ body, count: Math.min(Math.max(need, 1), DEFENSE_COUNT_CAP), behaviors }];
  }
}
