import { Overlord } from "./Overlord.js";
import { Combatant } from "../roles/Combatant.js";
import { behaviorClass } from "../behaviors/index.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";
import { Threat } from "../lib/Threat.js";

const WARBAND_PRIORITY = 5; // offence YIELDS to all economy + home defence (DefenseOverlord 1, GuardOverlord
// 4): the warband musters as the single spawn allows, never starving the economy or a home defender (#122).
const FLAG_PREFIX = "warband"; // a flag whose name starts with this marks the warband's objective room/point

// Default composition — a list of UNITS (the commander's "order a creep by {behaviors}" interface):
// each unit is a behavior SET + how many to field. The BODY is NOT specified here — it's read off the
// unit's default behavior (the model owns it, see spawnRequest). Overridable LIVE via Memory.warband
// without a redeploy. For OPERATION SUFFOCATE: 3 skirmishers (raidRoom + focusFire override) + 2 medics.
const DEFAULT_SPEC = {
  units: [
    { default: "raidRoom", nodes: ["focusFire"], count: 3 },
    { default: "healGroup", nodes: [], count: 2 },
  ],
  targetOwner: null, // username raidRoom hunts en route (e.g. "Robalian")
  tag: "alpha", // warband group tag — healGroup/groupAnchor coordinate the squad through it
};

// ============================================================================
//  WarbandOverlord — the commander's manual offence (#174), the first concrete
//  Directive (#25 made real) on top of the Behavior layer (#39). A STATELESS
//  controller (MVC): it holds no state of its own; it READS each unit's body off
//  its behavior (the model owns its conduct AND its body) and applies it to creeps,
//  and all durable state lives in the model (creep.memory). Two interfaces:
//
//   (a) Order units by their behaviors (+ optional body) — the composition spec
//       (Memory.warband, or the default): a list of { default, nodes, count } units.
//       The overlord spawns to match and stamps the behavior set. The BODY defaults
//       to the unit's default behavior's bodyFor (the model owns it), but a unit may
//       OVERRIDE it for custom power — `body` as an explicit module array, or as a
//       scalable template { base, extra, max } — see unitBody(). The override is the
//       commander's order (command input), not the controller re-deciding the body.
//   (b) Command the group by a destination — either a FLAG (name starts with
//       "warband", the visual / game-client lever) OR a memory objective
//       (Memory.warband.objective = { roomName, x, y }, the CLI lever — no
//       createFlag-vision needed); see objective(). The overlord points every member
//       at it; MOVE the flag / rewrite the objective to drive the operation (→ E16S7
//       clear the gatekeeper; → E18S7 seize + hold). Clear both → stand down (recall
//       home, no replacements; re-issue to re-muster).
//
//  Doctrine: it's COMMANDED, so it does NOT gate on Threat.winnable — that gate is
//  HEAL-blind (Threat.combatPower ignores HEAL, so a healing squad reads as falsely
//  winnable, #39/#176) and the commander owns the go/no-go anyway. Discipline still
//  holds: home defence preempts (recall on Threat.isHot(home) — itself HEAL-blind,
//  so it fires on attack/ranged threats, which is what a home assault brings), and
//  the warband musters FULL at home before launching (a rally — never feed it
//  piecemeal into a squad's massed fire). Singleton owning the unique role
//  "combatant" (no other overlord claims it → no instanceId, like ScoutOverlord).
// ============================================================================
export class WarbandOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: WARBAND_PRIORITY });
  }

  get role() {
    return "combatant";
  }

  // The commander's objective, normalised to { roomName, x, y }, or null = stand down. Two levers:
  // a `warband*` FLAG (the visual / game-client lever, takes precedence when present) OR a memory
  // objective `Memory.warband.objective = { roomName, x, y }` (the programmatic / CLI lever — no
  // createFlag-vision needed). Flag wins if both are set, so a dropped flag always overrides the
  // memory coords; remove it to fall back to them.
  objective() {
    const flag = Object.values(Game.flags).find((f) => f.name.startsWith(FLAG_PREFIX));
    if (flag) return { roomName: flag.pos.roomName, x: flag.pos.x, y: flag.pos.y };
    const o = this.spec().objective;
    if (o && o.roomName) return { roomName: o.roomName, x: o.x ?? 25, y: o.y ?? 25 };
    return null;
  }

  // The composition spec: code default overlaid with the live Memory override.
  spec() {
    return { ...DEFAULT_SPEC, ...(Memory.warband || {}) };
  }

  units() {
    return this.spec().units || [];
  }

  // Members fielding a given unit — identified by their DEFAULT behavior (the unit's identity), so
  // each unit's quota is counted SEPARATELY rather than against the whole-warband assignedCreeps.length
  // (the multi-unit overcount trap, #149).
  membersOf(unit) {
    return this.assignedCreeps.filter((c) => c.memory.behaviors?.default === unit.default);
  }

  // Spawn for the first unit below its count. Counts the SPECIFIC unit, never assignedCreeps.length; only while a
  // flag stands (no order → no muster; survivors then idle home and aren't replaced as they expire).
  generateSpawnRequest() {
    if (!this.objective()) return null;
    for (const unit of this.units()) {
      if (!behaviorClass(unit.default)) continue; // typo'd/unknown behavior in a live spec → skip, don't throw
      if (this.membersOf(unit).length < unit.count) return this.spawnRequest(unit);
    }
    return null;
  }

  // The body for a unit. Default: READ off its default behavior (the model owns it). Override (the
  // commander's "+ body" order): `unit.body` as either an explicit module array (used verbatim) or a
  // template { base, extra, max } scaled to the budget. The controller never INVENTS a body — it uses
  // the behavior's or the commander's.
  //
  // SIZING: the body scales to the colony's full spawn budget (energyCapacityAvailable) by DEFAULT —
  // but a unit may set `budget` to cap it LOWER, so a developed colony can still order CHEAP units (a
  // swarm, a probe, a throwaway) instead of being forced to max-size everything. Capped at the colony's
  // budget (can't order a body it can't afford). The explicit module array ignores this (it IS the body).
  unitBody(unit) {
    const cap = this.colony.spawnEnergyBudget();
    const budget = unit.budget ? Math.min(unit.budget, cap) : cap;
    const b = unit.body;
    if (Array.isArray(b)) return b; // explicit module array (verbatim — the commander sizes it within ecap)
    if (b && b.base) {
      return bodyFromTemplate(b.base, { extra: b.extra || [], max: b.max || 0, energy: budget });
    }
    return behaviorClass(unit.default).bodyFor(budget); // behavior's default body, sized to the budget
  }

  // Build a member of `unit`. The behavior SET + group tag are stamped so BehaviorMachine drives it;
  // the objective fields are stamped per tick in command().
  spawnRequest(unit) {
    return {
      priority: this.priority,
      role: this.role,
      body: this.unitBody(unit),
      memory: {
        role: this.role,
        colony: this.colony.name,
        overlord: this.identifier,
        warband: this.spec().tag,
        behaviors: { default: unit.default, nodes: unit.nodes },
      },
    };
  }

  // Has the full warband mustered (every unit at strength and done spawning)? The rally gate — we
  // don't advance until the group can fight as one.
  rallied() {
    return this.units().every(
      (u) => this.membersOf(u).filter((c) => !c.spawning).length >= u.count
    );
  }

  // Reconcile the objective onto every member each tick, then drive them.
  run() {
    const objective = this.objective();
    const rallied = this.rallied();
    for (const creep of this.assignedCreeps) this.command(creep, objective, rallied);
    super.run();
  }

  // Point one member at the right place (the behaviors re-read this next tick — moving the flag or
  // rewriting the memory objective retasks the live group, #39). The LAUNCHED latch lives on the creep
  // (model state, not controller state): once the warband has mustered, the member latches launched and
  // STAYS launched even if a squadmate later dies — so a loss never yanks the survivors back to rally;
  // the loss just respawns. A member advances to the objective only once launched AND home is safe;
  // otherwise it sits at home — which covers BOTH the pre-launch rally AND the home-defence recall
  // (defence > offence, #122).
  command(creep, objective, rallied) {
    if (rallied) creep.memory.launched = true;
    const home = this.colony.name;
    const advance = objective && creep.memory.launched && !Threat.isHot(home);
    creep.memory.target = advance ? objective.roomName : home;
    if (objective) {
      creep.memory.point = { x: objective.x, y: objective.y, roomName: objective.roomName };
      creep.memory.targetOwner = this.spec().targetOwner || null; // raidRoom en-route hunt
    } else {
      // Stand-down: clear the objective fields so a holdPoint unit doesn't keep holding a stale tile.
      creep.memory.point = null;
      creep.memory.targetOwner = null;
    }
  }

  runCreep(creep) {
    Combatant.run(creep, this.colony);
  }
}
