import { Overlord } from "./Overlord.js";
import { Guard } from "../roles/Guard.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  GuardOverlord — owns the combat-clearing domain (#118, Levels 2-3 of the
//  threat ladder). A cheap enemy harasser can deny a remote room and kill our
//  static economy creeps; passive retreat (#105, Level 1) only reroutes elsewhere
//  and abandons the room. This controller dispatches a dynamically-built Guard to
//  CLEAR a contested remote we want — but only when the fight is WINNABLE.
//
//  Singleton domain controller (mirrors RemoteMiningOverlord): reads the shared
//  Threat intel and considers the rooms in our remote footprint. Two-axis decision
//  — threat (what's needed) × economy (what's affordable): a room is winnable when
//  the guard we can afford RIGHT NOW out-guns the room's assessed threat. As the
//  economy grows the affordable guard grows, so we reclaim progressively bigger
//  threats; a threat beyond our weight class stays Level-1 (we never feed a guard to
//  a real army). Once a guard clears a room, our vision drops the intel to 0 and the
//  whole remote stack (mine/reserve/work/haul) flows back on its own.
// ============================================================================
export class GuardOverlord extends Overlord {
  constructor(colony) {
    // Priority 4: ahead of the remote economy (5) — one guard unblocks the whole
    // remote footprint, so it's worth spawning before more remote miners.
    super(colony, { priority: 4 });
  }

  get role() {
    return "guard";
  }

  // Distinct remote rooms that are hot AND winnable: the guard we can afford this
  // spawn out-guns the room's assessed threat. Reads intel (threat + profile) — no
  // live vision needed, it was recorded when a creep last saw the room.
  hotWinnableRooms() {
    if (this._hotWinnable !== undefined) return this._hotWinnable; // per-tick memo (instance is rebuilt each tick)
    const budget = this.colony.spawnEnergyBudget();
    const rooms = [...new Set(this.colony.remoteSources().map((s) => s.room))];
    this._hotWinnable = rooms.filter((room) => {
      if (!Threat.isHot(room)) return false;
      const profile = Threat.profileFor(room);
      // Need a MOBILE enemy to kill: a guard targets creeps, so a threat that's only
      // an invader core (threat=1, no attack/ranged parts) can't be cleared by it —
      // leave those Level-1 (clearing a core is a later capability).
      if (!profile || profile.attack + profile.ranged === 0) return false;
      const body = Guard.bodyFor(budget, profile);
      return Threat.guardCombatPower(body) > Threat.threatOf(room);
    });
    return this._hotWinnable;
  }

  // Informational headcount (the real dispatch logic is covered-room-based below).
  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.hotWinnableRooms().length;
  }

  // Rooms already held by a live guard whose assignment is still hot-winnable.
  coveredRooms() {
    const win = new Set(this.hotWinnableRooms());
    return new Set(
      this.assignedCreeps.map((c) => c.memory.guardRoom).filter((r) => r && win.has(r))
    );
  }

  // Spawn one guard for the best uncovered hot-winnable room. Built directly (not via
  // the base count gate) so a guard recycling from a just-cleared room never blocks
  // dispatching one to a still-contested room. Gated on expansionReady (and thus the
  // recovering crisis veto) — never spawn a guard the core can't afford.
  generateSpawnRequest() {
    if (!this.colony.health.expansionReady) return null;
    const covered = this.coveredRooms();
    const room = this.hotWinnableRooms().find((r) => !covered.has(r));
    if (!room) return null;
    const profile = Threat.profileFor(room);
    if (!profile) return null; // intel went stale between filter and here → don't spawn blind
    return {
      priority: this.priority,
      role: this.role,
      body: Guard.bodyFor(this.colony.spawnEnergyBudget(), profile),
      memory: {
        role: this.role,
        colony: this.colony.name,
        overlord: this.identifier,
        guardRoom: room,
        guardType: Guard.counterType(profile),
      },
    };
  }

  // Release a guard whose room is no longer hot-winnable (cleared, cooled, or now out
  // of our weight class) so the role recycles it; a guard in a still-winnable room
  // keeps fighting.
  run() {
    const win = new Set(this.hotWinnableRooms());
    for (const creep of this.assignedCreeps) {
      if (creep.memory.guardRoom && !win.has(creep.memory.guardRoom)) {
        creep.memory.guardRoom = null;
      }
    }
    super.run();
  }

  runCreep(creep) {
    Guard.run(creep, this.colony);
  }
}
