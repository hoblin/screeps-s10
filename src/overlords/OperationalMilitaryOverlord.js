import { Overlord } from "./Overlord.js";
import { Soldier } from "../roles/Soldier.js";
import { BustCoreMission } from "../missions/BustCoreMission.js";

const OPS_PRIORITY = 4; // clearing a seized remote restores its income — same tier as Guard (defense /
// clearing precedes the remote economy). The unified domain owns more here as missions migrate.

// ============================================================================
//  OperationalMilitaryOverlord (#259) — the unified military domain controller: it owns the whole
//  threat → counter-composition → spawn → lead loop for the colony. A SINGLE stateless domain controller
//  (overlord-is-a-domain-controller), NOT one overlord per threat: the spawn + lead machinery is identical
//  across missions — only the recogniser and target differ — so missions are typed objects inside one
//  owner, and (Slice 3) the manual offensive is just a second activation SOURCE rather than a parallel class.
//
//  THE GROUP SPINE — this overlord is the TYPE-AGNOSTIC backbone; each mission owns its own composition and
//  lifecycle:
//   • missions() aggregates each mission TYPE's autonomous recogniser (a static factory). Adding a TYPE =
//     one line here; adding the manual SOURCE (Slice 3) = appending manualMissions(). The backbone is
//     untouched either way.
//   • a mission's force is a ROSTER (unit-types × counts), not a single body. generateSpawnRequest fields
//     it by COUNT-COVERAGE — the first roster slot still below its count across all active missions — so a
//     mission musters a whole GROUP, not one creep. This replaces the old one-creep-per-room "presence"
//     gate (the single-creep dispatcher, the anti-goal).
//   • each mission drives its own stage machine (muster → deploy → execute → resolve) via mission.drive();
//     the overlord only dispatches members to their mission and runs the base creep loop. Units then run
//     BehaviorMachine tactics on the behaviour layer (the overlord never rewrites role logic).
//
//  FIRST mission: BustCoreMission (an L0 invader core squatting a remote — the live trigger E13S5). The
//  remaining missions (defend-home / clear-remote / retaliate / manual-offense) and the eventual removal of
//  GuardOverlord + WarbandOverlord are follow-up slices that slot into missions() without touching this
//  backbone; until then this overlord runs ALONGSIDE them, owning only its own "soldier" units.
// ============================================================================
export class OperationalMilitaryOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: OPS_PRIORITY });
  }

  get role() {
    return "soldier";
  }

  // Every active mission this tick (memoised — overlord instances are rebuilt each tick). Today only the
  // autonomous source is armed; Slice 3 appends the manual source: missions() = autonomous ⊕ manual.
  missions() {
    if (this._missions !== undefined) return this._missions;
    this._missions = this.autonomousMissions();
    return this._missions;
  }

  // The AUTONOMOUS source: aggregate each mission TYPE's static recogniser factory. Recognition lives on
  // the mission (cohesion); this only concatenates. New TYPE = one more spread.
  autonomousMissions() {
    return [...BustCoreMission.autoMissions(this.colony)];
  }

  // Members fielding a given mission, grouped by the mission key stamped on each at spawn.
  membersOf(mission) {
    return this.assignedCreeps.filter((c) => c.memory.mission === mission.key);
  }

  // COUNT-COVERAGE spawn (the type-agnostic backbone): field the first roster slot still below its count
  // across all active missions, honouring each mission's own replacement policy (canSpawn). A mission thus
  // fields a full GROUP, not one creep. An unaffordable (empty) body skips the slot — never a worker
  // fallback (a combatant is armed or it is not born, #234).
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

  // Drive each mission's stage machine (muster → deploy → execute), then run the creeps. The overlord only
  // dispatches members to their mission; the mission owns the lead-as-group lifecycle.
  run() {
    for (const mission of this.missions()) mission.drive(this.membersOf(mission));
    super.run();
  }

  runCreep(creep) {
    Soldier.run(creep, this.colony);
  }
}
