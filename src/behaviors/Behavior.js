import { Role } from "../roles/Role.js";

// ============================================================================
//  Behavior — base for a named, stateless unit of creep conduct (#39).
//
//  A creep's conduct is COMPOSED from a SET of these (picked each tick by the
//  BehaviorMachine) instead of being frozen to one Role. Mirrors the Role shape
//  — static methods, no per-creep allocation, run(creep, colony) — but a creep
//  is now "body + composable behaviors", re-taskable on the fly: rewrite
//  creep.memory.behaviors (via the #174 command interface / set_memory) and the
//  switch takes effect next tick.
//
//  EDGES (the trigger spine, mirrored from Stages.js one level down): a SPECIAL
//  node may declare a paired entry edge `enteredWhen(creep, colony)` that pulls a
//  creep INTO it from the default, and an exit edge `exitWhen(creep, colony)` that
//  releases it back to the default. Both default to absent — a plain node (used as
//  the default, or a commanded mission) carries no edges and simply runs.
// ============================================================================
export class Behavior {
  // Subclasses implement the conduct. Static — `this` is the Behavior class.
  static run(_creep, _colony) {
    throw new Error("Behavior subclass must implement run(creep, colony)");
  }

  // Telemetry tag (#103/#123) — reuse the single Role definition so a behavior's
  // per-tick action shows in the trace + as an in-game speech bubble, exactly like
  // a role's. Tag shape stays "category:action" (e.g. "raid:deny", "heal:heal").
  static note(creep, action) {
    Role.note(creep, action);
  }

  // Guard.engage branches on creep.memory.guardType ("melee" vs "ranged"); a
  // commanded combatant needn't carry one, so derive it from the BODY (any ATTACK
  // part → melee, else ranged) and stamp it where engage reads it. Body-authoritative
  // and recomputed each call (the body is immutable) rather than cached — so a creep
  // retasked across archetypes never reads a stale mode a prior behavior wrote.
  static ensureCombatMode(creep) {
    const mode = creep.getActiveBodyparts(ATTACK) > 0 ? "melee" : "ranged";
    creep.memory.guardType = mode;
    return mode;
  }

  // Fellow warband members — my live creeps sharing this creep's `memory.warband`
  // group tag (excluding itself). The lightweight grouping the squad behaviors
  // (FocusFire / HealGroup / KiteScreen) coordinate through; absent tag → no group.
  static warbandMates(creep) {
    const tag = creep.memory.warband;
    if (!tag) return [];
    return Object.values(Game.creeps).filter(
      (c) => c.memory.warband === tag && c.name !== creep.name
    );
  }

  // The point to regroup toward to stay with the squad: the nearest mate in THIS
  // room, else any mate (travelTo handles the cross-room hop). Null with no group.
  static groupAnchor(creep) {
    const mates = this.warbandMates(creep);
    if (!mates.length) return null;
    const here = mates.filter((c) => c.room.name === creep.room.name);
    return here.length ? creep.pos.findClosestByRange(here) : mates[0];
  }
}
