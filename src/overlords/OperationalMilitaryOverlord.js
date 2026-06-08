import { Overlord } from "./Overlord.js";
import { Soldier } from "../roles/Soldier.js";
import { Threat } from "../lib/Threat.js";
import { antiCoreBody } from "../lib/CombatBody.js";
import { towerFreeRoute } from "../lib/Routing.js";

const OPS_PRIORITY = 4; // clearing a seized remote restores its income — same tier as Guard (defense /
// clearing precedes the remote economy). The unified domain owns more here as missions migrate.
const TILES_PER_ROOM = 50; // rough tiles/room → travel ticks for the collapse-timer worthwhileness gate

// ============================================================================
//  OperationalMilitaryOverlord (#259) — the unified military domain controller: it owns the whole
//  threat → counter-composition → spawn → lead loop for the colony. It recognises a threat TYPE from
//  Threat intel, composes the cost-effective counter, spawns it via the standard contract, and leads it
//  by stamping the steering memory the behaviour layer reads (the WarbandOverlord.command pattern).
//  A SINGLE stateless domain controller (overlord-is-a-domain-controller), NOT one typed overlord per
//  threat: the spawn + steering machinery is identical across missions — only the recogniser and target
//  differ — so missions are typed SUB-missions inside one owner, and the manual offensive is just a
//  fifth mission type rather than a parallel class.
//
//  ARCHITECTURE — the typed-mission framework:
//   • missions() composes one recogniser per mission TYPE; each returns concrete missions shaped
//     { type, room, point?, composition (body array), targetOwner?, behaviors }.
//   • the SPAWN BACKBONE (generateSpawnRequest / coveredRooms) is TYPE-AGNOSTIC: it fields the first
//     uncovered mission's composition and stamps its behaviour set + target. Adding a mission type =
//     a new recogniser in missions(); the backbone is untouched.
//   • the STEERING SEAM (the per-tick command() rewrite of memory.target/point/targetOwner) is added
//     only when a mission whose target MOVES arrives (manual-offense following a flag). bust-core's
//     target is a FIXED room, so the base run() (drive each creep via the BehaviorMachine) suffices —
//     no steering loop is built before a mission needs it (defer-abstraction-until-second-instance).
//
//  FIRST mission: bust-core — the live trigger (an invader core squatting our remote E13S5, reserving
//  the controller so the reserver is kicked and mining is dead). The remaining missions (defend-home /
//  defend-child / clear-remote / retaliate / manual-offense) and the eventual removal of GuardOverlord +
//  WarbandOverlord are follow-up tickets that slot into missions() without touching the backbone; until
//  then this overlord runs ALONGSIDE them, owning only its own "soldier" units.
// ============================================================================
export class OperationalMilitaryOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: OPS_PRIORITY });
  }

  get role() {
    return "soldier";
  }

  // Every active mission this tick, across all typed recognisers (memoised per tick — overlord
  // instances are rebuilt each tick). Today only bust-core is armed; new mission types append here.
  missions() {
    if (this._missions !== undefined) return this._missions;
    this._missions = [...this.bustCoreMissions()];
    return this._missions;
  }

  // BUST-CORE recogniser: a remote of OURS seized by an invader core (it reserves our controller,
  // kicking the reserver and killing mining). Scoped to the remote footprint — the economy it protects.
  // Each qualifying room gets a cheap pure-ATTACK buster, gated by worthwhileness (invuln + collapse).
  bustCoreMissions() {
    const budget = this.colony.spawnEnergyBudget();
    const rooms = [...new Set(this.colony.remoteSources().map((s) => s.room))];
    const out = [];
    for (const room of rooms) {
      if (!Threat.coreSeized(room)) continue;
      if (!this.coreWorthBusting(room, budget)) continue;
      out.push({
        type: "bust-core",
        room,
        composition: antiCoreBody(budget),
        behaviors: { default: "bustCore", nodes: ["selfDefense"] },
      });
    }
    return out;
  }

  // The invulnerability + collapse-timer worthwhileness gate (doctrine §1). With detailed core intel:
  // never dispatch while invulnerable, and skip a core that self-collapses before a buster could arrive
  // AND grind it down (pull the remote and wait instead). Without detailed intel yet (only the reservation
  // proxy fired — recon hasn't captured the core's HP/timers), dispatch and let BustCore confirm
  // invulnerability live on arrival.
  coreWorthBusting(room, budget) {
    const core = Threat.invaderCore(room);
    if (!core) return true; // reservation proxy only (an L0 reservation core) — confirm on arrival
    if (core.level > 0) return false; // a stronghold (towers + boosted defenders) — needs a boosted squad, not this cheap buster (out of scope)
    if (core.invulnerableUntil && Game.time < core.invulnerableUntil) return false;
    if (core.collapseAt) {
      const dps = Math.max(1, antiCoreBody(budget).filter((p) => p === ATTACK).length * ATTACK_POWER);
      const arriveAndGrind = this.travelTicks(room) + core.hits / dps;
      if (core.collapseAt - Game.time < arriveAndGrind) return false; // dies on its own first
    }
    return true;
  }

  // Rough travel time home → room (tower-free hops × tiles/room), for the collapse-timer gate.
  travelTicks(room) {
    const route = towerFreeRoute(this.colony.name, room);
    return (route ? route.length : 1) * TILES_PER_ROOM;
  }

  // Rooms already held by one of our units whose mission is still active — so we field ONE buster per
  // seized remote, not a stream.
  coveredRooms() {
    const want = new Set(this.missions().map((m) => m.room));
    return new Set(this.assignedCreeps.map((c) => c.memory.target).filter((r) => r && want.has(r)));
  }

  // Field the first uncovered mission's composition, stamping its behaviour set + target (the
  // TYPE-AGNOSTIC spawn backbone). The empty-composition guard catches the "can't afford an armed body"
  // case once #234 makes the combat sizer step down to [] (today a too-poor budget instead hits the
  // generic worker fallback — a systemic combat-body issue #234 fixes, not specific to this mission).
  generateSpawnRequest() {
    const covered = this.coveredRooms();
    const mission = this.missions().find((m) => !covered.has(m.room));
    if (!mission || !mission.composition.length) return null;
    return {
      priority: this.priority,
      role: this.role,
      body: mission.composition,
      memory: {
        role: this.role,
        colony: this.colony.name,
        overlord: this.identifier,
        mission: mission.type, // the mission tag (steering seam keys off it once missions move targets)
        target: mission.room,
        targetOwner: mission.targetOwner || null,
        behaviors: mission.behaviors,
      },
    };
  }

  runCreep(creep) {
    Soldier.run(creep, this.colony);
  }
}
