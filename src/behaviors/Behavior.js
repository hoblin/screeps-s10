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
//  DOMAIN-NEUTRAL (#204): this base carries ONLY what every behavior shares —
//  the run contract, the body contract, and the telemetry tag. Combat-specific
//  conduct (the ranged-kite body default, warband squad helpers) lives one level
//  down in CombatBehaviour; economy behaviors (RemoteHaul) extend this base
//  directly, so no behavior inherits a body or helper from a domain it isn't in
//  (Liskov + SRP — combat was just the first tenant, not the base).
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

  // The body this behavior needs to do its job (MVC: the behavior is the MODEL — it owns BOTH its
  // conduct AND its body requirement; a controller like WarbandOverlord/RemoteLogisticsOverlord READS
  // this off the unit's DEFAULT behavior and spawns it, never re-deciding the body itself). Abstract
  // on the neutral base — there is no universal default body, so every behavior MUST declare its own
  // (CombatBehaviour gives combat units the ranged-kite default; RemoteHaul returns a CARRY/MOVE body).
  static bodyFor(_energyBudget) {
    throw new Error("Behavior subclass must implement bodyFor(energyBudget)");
  }

  // Telemetry tag (#103/#123) — reuse the single Role definition so a behavior's
  // per-tick action shows in the trace + as an in-game speech bubble, exactly like
  // a role's. Tag shape stays "category:action" (e.g. "raid:deny", "rhaul:withdraw").
  static note(creep, action) {
    Role.note(creep, action);
  }
}
