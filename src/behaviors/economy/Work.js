import { Behavior } from "../Behavior.js";
import { Role } from "../../roles/Role.js";
import { Hauler } from "../../roles/Hauler.js";
import { fallback } from "../combinators.js";
import { bodyFromTemplate } from "../../lib/BodyGenerator.js";
import { BuildSpawn } from "./BuildSpawn.js";
import { FillStructures } from "./FillStructures.js";
import { Build } from "./Build.js";
import { Repair } from "./Repair.js";
import { Upgrade } from "./Upgrade.js";

// ============================================================================
//  Work (#239) — the general-purpose builder/filler/repairer/upgrader, lifted out of the
//  procedural Worker role into the behaviour paradigm (the 3rd Behavior tenant after combat
//  and RemoteHaul). A worker is a TWO-LEVEL loop:
//
//   • ENERGY CYCLE (gather↔work) — reuses the shared Hauler.runCycle FSM: gather until full
//     (collect), then spend until empty (deliver). Identical hysteresis to the hauler.
//   • TASK PRIORITY (when spending) — a stateless `fallback` of economy atoms (NOT a latching
//     BehaviorMachine; the chain re-picks the highest doable task each tick): build-SPAWN > fill >
//     build-rest > repair > upgrade. The spawn is the singular critical structure, so building it
//     outranks even filling (a colony with no spawn can't produce creeps — build it, then fill it,
//     then everything else). Each atom self-gates (returns false when it can't/shouldn't act), and
//     each commits to its target (committedTarget) so a worker doesn't rotate/re-path mid-transit.
//
//  COMMAND PATTERN: build SITE SELECTION lives in WorkOverlord (it stamps memory.buildTarget,
//  fleet-concentrated + per-trip latched); the Build atom only executes the stamp. runCycle
//  clears memory.haulTarget on the full-load edge — a DIFFERENT key from buildTarget, and a
//  worker never sets haulTarget (its collect is the gather ladder, not Hauler.collect), so the
//  build latch survives the gather↔work boundary untouched (the worker returns to its site).
// ============================================================================
export class Work extends Behavior {
  // The worker body (the model owns it; WorkOverlord reads this off the default behavior).
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 5, energy: energyBudget });
  }

  // Drive the gather↔work cycle with THIS class as the conduct (collect/deliver below).
  static run(creep, colony) {
    Hauler.runCycle(creep, colony, this);
  }

  // ---- collect: the shared, stage-aware refuel ladder (dropped > delivered container/storage
  //      > pre-2b source harvest > post-2b park). Role.gatherEnergy owns the #37 survival +
  //      source-container-reservation invariants; call it on Role so its `this` (and the
  //      gather movement priority #58) resolve correctly.
  static collect(creep, colony) {
    this.note(creep, "work:gather");
    Role.gatherEnergy(creep, colony);
  }

  // ---- deliver: the work priority chain as a fallback of self-gating atoms. BuildSpawn first
  //      (the spawn outranks filling), then fill, then the overlord-assigned bulk build, repair, upgrade.
  static deliver(creep, colony) {
    fallback(creep, colony, [BuildSpawn, FillStructures, Build, Repair, Upgrade]);
  }
}
