import { Overlord } from "./Overlord.js";
import { Soldier } from "../roles/Soldier.js";
import { Threat } from "../lib/Threat.js";
import { towerFreeRoute } from "../lib/Routing.js";
import { DefendHomeMission } from "../missions/DefendHomeMission.js";
import { DefendChildMission } from "../missions/DefendChildMission.js";
import { ClearRemoteMission } from "../missions/ClearRemoteMission.js";
import { BustCoreMission } from "../missions/BustCoreMission.js";

const OPS_PRIORITY = 4; // defence / remote-clearing precedes the remote economy — same tier the old Guard held.

// Sunk-asset retaliation tuning (ported from GuardOverlord): how stale intel may be to trust ownership,
// the travel-ticks/room estimate, the minimum life a guard must keep AFTER arrival to be worth sending,
// and how often an idle guard re-scans for a deniable target.
const RETALIATE_FRESH = 1000;
const RETALIATE_TILES_PER_ROOM = 50;
const RETALIATE_MIN_DENY = 100;
const RETALIATE_SCAN_INTERVAL = 25;

// ============================================================================
//  OperationalMilitaryOverlord (#259) — the unified military domain controller: it owns the whole
//  threat → counter-composition → spawn → lead loop for the colony. A SINGLE stateless domain controller
//  (overlord-is-a-domain-controller), NOT one overlord per threat: the spawn + lead machinery is identical
//  across missions — only the recogniser and target differ — so missions are typed objects inside one
//  owner. As of Slice 2 it owns all of reactive defence (home / child / clear-remote / retaliate, migrated
//  off the retired GuardOverlord) plus bust-core; it runs alongside WarbandOverlord until Slice 3 folds the
//  manual offensive in as a second activation source.
//
//  THE GROUP SPINE — this overlord is the TYPE-AGNOSTIC backbone; each mission owns its composition and
//  lifecycle:
//   • autonomousMissions() aggregates each mission TYPE's recogniser factory, in the home > child >
//     clear-remote > bust-core PRIORITY order (generateSpawnRequest fields the first under-count slot in
//     that order, so home defence wins the spawn first).
//   • a mission's force is a ROSTER (unit-types × counts); generateSpawnRequest fields it by COUNT-COVERAGE
//     (per-roster-slot headcount), honouring each mission's replacement policy — so a mission musters a
//     whole GROUP, not one creep.
//   • each mission drives its own stage machine (mission.drive). A soldier with NO active mission is
//     resolved here: it either RETALIATES (it fought an attacker and home is safe → deny that attacker's
//     nearest tower-free remote for the rest of its life) or is recalled home. This single resolve stage
//     replaces GuardOverlord.manageRetaliation.
// ============================================================================
export class OperationalMilitaryOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: OPS_PRIORITY });
  }

  get role() {
    return "soldier";
  }

  // Every active mission this tick (memoised — overlord instances are rebuilt each tick). Slice 3 appends
  // the manual source here: missions() = autonomous ⊕ manual.
  missions() {
    if (this._missions !== undefined) return this._missions;
    this._missions = this.autonomousMissions();
    return this._missions;
  }

  // The AUTONOMOUS source: each mission TYPE's static recogniser factory, concatenated in PRIORITY order
  // (home > child > clear-remote > bust-core). Adding a TYPE = one more spread; the backbone is untouched.
  autonomousMissions() {
    return [
      ...DefendHomeMission.autoMissions(this.colony),
      ...DefendChildMission.autoMissions(this.colony),
      ...ClearRemoteMission.autoMissions(this.colony),
      ...BustCoreMission.autoMissions(this.colony),
    ];
  }

  // Members fielding a given mission, grouped by the mission key stamped on each at spawn.
  membersOf(mission) {
    return this.assignedCreeps.filter((c) => c.memory.mission === mission.key);
  }

  // COUNT-COVERAGE spawn (the type-agnostic backbone): field the first roster slot still below its count
  // across all active missions (in priority order), honouring each mission's replacement policy (canSpawn).
  // A mission thus fields a full GROUP, not one creep. An unaffordable (empty) body skips the slot — never
  // a worker fallback (a combatant is armed or it is not born, #234).
  generateSpawnRequest() {
    for (const mission of this.missions()) {
      const members = this.membersOf(mission);
      if (!mission.canSpawn(members)) continue;
      for (const slot of mission.roster()) {
        if (!slot.body.length) continue; // can't afford an armed body → skip this slot
        const filled = members.filter((c) => c.memory.behaviors?.default === slot.behaviors.default).length;
        if (filled < slot.count) return this.spawnRequest(mission, slot);
      }
    }
    return null;
  }

  // Build a member of a roster slot: stamp the mission key (for grouping + count-coverage), the target
  // room, and the slot's behaviour set (BehaviorMachine drives it; mission.drive re-steers target per tick).
  spawnRequest(mission, slot) {
    return {
      priority: this.priority,
      role: this.role,
      body: slot.body,
      memory: {
        role: this.role,
        colony: this.colony.name,
        overlord: this.identifier,
        mission: mission.key,
        target: mission.room,
        behaviors: slot.behaviors,
      },
    };
  }

  // Drive each mission's stage machine, then resolve every leftover soldier: one with no active mission
  // either RETALIATES (fought an attacker, home safe → deny its remote) or is recalled home. Then run the
  // creeps.
  run() {
    const driven = new Set();
    for (const mission of this.missions()) {
      const members = this.membersOf(mission);
      mission.drive(members);
      for (const creep of members) driven.add(creep.name);
    }
    for (const creep of this.assignedCreeps) {
      if (driven.has(creep.name)) continue;
      if (!this.retaliate(creep)) creep.memory.target = this.colony.name; // retaliate, else recall home
    }
    super.run();
  }

  // Sunk-asset retaliation — the resolve stage for a defender with no active mission (ported from
  // GuardOverlord.manageRetaliation, #122/#176). A guard that just won (idle in a cooled post, having
  // fought an armed attacker) is sent to deny that attacker's nearest deniable tower-free remote for the
  // rest of its life — paying the attack back by disabling its economy. Returns true while the creep is
  // on/continuing a retaliation, so it is NOT recalled home. Home threat always preempts (defence > offence).
  retaliate(creep) {
    if (creep.memory.targetOwner) {
      if (Threat.isHot(this.colony.name)) {
        creep.memory.target = this.colony.name; // home assaulted — recall
        creep.memory.targetOwner = null;
        return false;
      }
      if (!this.deniable(creep.memory.target, creep.memory.foughtOwner, creep)) {
        creep.memory.targetOwner = null; // attacker left / built a tower / intel stale → stand down
        return false;
      }
      return true; // keep denying (target already set)
    }
    if (creep.room.name !== creep.memory.target) return false; // still in transit to a post
    if (Threat.isHot(creep.memory.target)) return false; // its room is still hot — keep defending
    if (!creep.memory.foughtOwner) return false; // never fought an armed hostile → nothing to retaliate for
    if (Game.time - (creep.memory.retScan || 0) < RETALIATE_SCAN_INTERVAL) return false;
    creep.memory.retScan = Game.time;
    const target = this.retaliationTarget(creep.memory.foughtOwner, creep);
    if (!target) return false;
    creep.memory.target = target;
    creep.memory.targetOwner = creep.memory.foughtOwner; // raidRoom (in the defence behaviour set) carries it
    return true;
  }

  // Is `room` a remote we can deny `owner`? Fresh intel that confirms `owner` holds/reserves it, AND this
  // creep can win there (a towered room folds tower damage into its threat, so it reads unwinnable and is
  // rejected without an explicit tower check — retaliation stays tower-free).
  deniable(room, owner, creep) {
    if (!owner) return false;
    const intel = Memory.roomIntel?.[room];
    if (!intel || Game.time - intel.tick > RETALIATE_FRESH) return false;
    if (intel.owner !== owner && intel.reserver !== owner) return false;
    return Threat.winnableBy(creep, room);
  }

  // The attacker's nearest deniable remote reachable by a tower-free route, where the creep still arrives
  // with enough life left to deny it meaningfully. Shortest tower-free route wins.
  retaliationTarget(owner, creep) {
    let best = null;
    let bestLen = Infinity;
    for (const room of Object.keys(Memory.roomIntel || {})) {
      if (!this.deniable(room, owner, creep)) continue;
      const route = towerFreeRoute(creep.room.name, room);
      if (!route || route.length >= bestLen) continue;
      const travel = route.length * RETALIATE_TILES_PER_ROOM;
      if ((creep.ticksToLive || CREEP_LIFE_TIME) < travel + RETALIATE_MIN_DENY) continue;
      best = room;
      bestLen = route.length;
    }
    return best;
  }

  runCreep(creep) {
    Soldier.run(creep, this.colony);
  }
}
