import { Overlord } from "./Overlord.js";
import { Guard } from "../roles/Guard.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  GuardOverlord — owns the combat-clearing domain (#118, Levels 2-3 of the
//  threat ladder; home defense added in #122). A cheap enemy harasser can deny a
//  remote room and kill our static economy creeps; passive retreat (#105, Level 1)
//  only reroutes and abandons the room. This controller dispatches dynamically-built
//  Guards to clear contested rooms, HOME first, then remotes.
//
//  Singleton domain controller (mirrors RemoteMiningOverlord), reading the shared
//  Threat intel. Priority ladder + gating (#122 — defense is the GATE for expansion,
//  so it outranks the economy, NOT the other way round):
//   • HOME (top priority): if the home room has a real combat threat, field the best
//     AFFORDABLE guard unconditionally — no winnability filter (never abandon the
//     core; even a losing guard buys time + tower focus), no expansionReady gate, no
//     recovering veto. Defending the core is the survival floor.
//   • REMOTES: clear a contested remote only when WINNABLE (the guard we can afford
//     out-guns the assessed threat — never feed a guard to a real army) and we're not
//     in a workforce-collapse recovery (no economy to protect then). NOT gated on
//     expansionReady: a denied remote blocks expansion, so reclaiming it precedes
//     expansion rather than waiting on spare spawn-idle.
//  Two-axis sizing throughout: body scaled to the threat × energyCapacityAvailable.
//  Once a guard clears a room, our vision drops the intel to 0 and the economy flows
//  back on its own.
// ============================================================================
export class GuardOverlord extends Overlord {
  constructor(colony) {
    // Priority 4: a guard unblocks a whole room (home or a remote), so it spawns
    // ahead of the remote economy (5). Defense precedes expansion.
    super(colony, { priority: 4 });
  }

  get role() {
    return "guard";
  }

  // Distinct remote rooms that are hot AND winnable: the guard we can afford out-guns
  // the room's assessed threat. Reads intel (threat + profile) — no live vision
  // needed, it was recorded when a creep last saw the room. Memoized per tick.
  hotWinnableRooms() {
    if (this._hotWinnable !== undefined) return this._hotWinnable;
    const budget = this.colony.spawnEnergyBudget();
    const rooms = [...new Set(this.colony.remoteSources().map((s) => s.room))];
    this._hotWinnable = rooms.filter((room) => {
      if (!Threat.isHot(room)) return false;
      const profile = Threat.profileFor(room);
      // Need a MOBILE enemy to kill: a guard targets creeps, so a threat that's only
      // an invader core (no attack/ranged parts) can't be cleared by it — leave those
      // Level-1 (clearing a core is a later capability).
      if (!profile || profile.attack + profile.ranged === 0) return false;
      const body = Guard.bodyFor(budget, profile);
      return Threat.guardCombatPower(body) > Threat.threatOf(room);
    });
    return this._hotWinnable;
  }

  // The home room as a guard target, or null. UNCONDITIONAL within affordability —
  // no winnability filter, no expansionReady / recovering gate (home defense is the
  // survival floor). Requires a mobile combat threat (a guard can't kill a lone core)
  // and that we can field a real combat body.
  homeTarget() {
    const home = this.colony.name;
    if (!Threat.isHot(home)) return null;
    const profile = Threat.profileFor(home);
    if (!profile || profile.attack + profile.ranged === 0) return null;
    const body = Guard.bodyFor(this.colony.spawnEnergyBudget(), profile);
    return Threat.guardCombatPower(body) > 0 ? home : null;
  }

  // Every room wanting a guard, HOME FIRST then winnable remotes. Memoized per tick.
  targets() {
    if (this._targets !== undefined) return this._targets;
    const out = [];
    const home = this.homeTarget();
    if (home) out.push(home);
    // Remotes wait out a workforce-collapse recovery (nothing to protect then), but
    // are NOT expansionReady-gated — remote defense precedes expansion.
    if (!this.colony.health.recovering) {
      for (const room of this.hotWinnableRooms()) if (room !== home) out.push(room);
    }
    this._targets = out;
    return out;
  }

  desiredCount() {
    return this.targets().length;
  }

  // Rooms already held by a live guard whose assignment is still a current target.
  coveredRooms() {
    const want = new Set(this.targets());
    return new Set(
      this.assignedCreeps.map((c) => c.memory.guardRoom).filter((r) => r && want.has(r))
    );
  }

  // Spawn one guard for the best uncovered target (home first). Built directly (not
  // via the base count gate) so a guard recycling from a just-cleared room never
  // blocks dispatching one to a still-contested room.
  generateSpawnRequest() {
    const covered = this.coveredRooms();
    const room = this.targets().find((r) => !covered.has(r));
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

  // Release a guard whose room is no longer a target (cleared, cooled, or — for a
  // remote — now out of our weight class) so the role recycles it; a guard in a
  // still-targeted room keeps fighting.
  run() {
    const want = new Set(this.targets());
    for (const creep of this.assignedCreeps) {
      if (creep.memory.guardRoom && !want.has(creep.memory.guardRoom)) {
        creep.memory.guardRoom = null;
      }
    }
    super.run();
  }

  runCreep(creep) {
    Guard.run(creep, this.colony);
  }
}
