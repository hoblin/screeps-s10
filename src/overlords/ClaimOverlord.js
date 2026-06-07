import { Overlord } from "./Overlord.js";
import { Claimer } from "../roles/Claimer.js";
import { Pioneer } from "../roles/Pioneer.js";

// ============================================================================
//  ClaimOverlord — the expansion directive: claim a designated 2nd colony and
//  bootstrap it with pioneers until it stands on its own (#220 — the first #25
//  directive, built inline; the generic Directives layer waits for a 2nd kind).
//
//  Conditional, not standing: it requests nothing until ARMED and AFFORDABLE and
//  LEGAL. The target (room + controller tile) is an offline + human decision read
//  live from `Memory.expansion.claimTarget = { room, controller:{x,y}, home }` — the
//  bot executes a designated target, it never gambles on one. Only the colony named
//  as `home` runs the directive, so two colonies don't race for the same room.
//
//  Two phases over ONE domain (claim then bootstrap), so one overlord owns both
//  roles (like ScoutOverlord owning scout+hunter):
//    1. CLAIM — while the target is unowned, keep one claimer heading to it.
//    2. BOOTSTRAP — once it's ours (the Kernel auto-discovers it as a Colony), stream
//       pioneers from home to build its first spawn; stop the instant that spawn
//       stands and the new colony spawns for itself.
//
//  Gated like the other expansion overlords on home-economy health (expansionReady),
//  plus GCL headroom (can't claim past Game.gcl.level) and "target still unowned".
//  Sits at priority 5 (the expansion tier) so the home economy always spawns first.
// ============================================================================

// Seed crew that builds the first spawn and keeps the new controller from
// downgrading during the cold start. A handful is plenty — they self-harvest a
// fresh room's two sources and the work is finite (stops once the spawn stands).
const PIONEER_COUNT = 3;

export class ClaimOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // expansion tier — below the home economy
  }

  get role() {
    return "claimer";
  }

  get roles() {
    return ["claimer", "pioneer"]; // owns the whole claim → bootstrap domain
  }

  // The armed target, but ONLY for the colony designated as its home — so a 2nd
  // colony's own ClaimOverlord stays idle instead of racing for the same room. A
  // target with no `home` defaults to whichever colony reads it (single-colony case).
  target() {
    const t = Memory.expansion?.claimTarget;
    if (!t || !t.room || !t.controller) return null;
    if ((t.home || this.colony.name) !== this.colony.name) return null;
    return t;
  }

  // Owned-colony count vs GCL: we may claim only with GCL headroom. Every owned room
  // is always visible (controller.my), so Game.rooms is the full set to count.
  hasGclHeadroom() {
    const owned = Object.keys(Game.rooms).filter(
      (n) => Game.rooms[n].controller && Game.rooms[n].controller.my
    ).length;
    return owned < Game.gcl.level;
  }

  // May the directive act at all this tick? Armed for this home, economy healthy (the
  // same gate the remotes use), and not clawing back from a workforce collapse.
  active() {
    if (!this.target()) return false;
    if (this.colony.health.recovering) return false;
    return this.colony.health.expansionReady;
  }

  // Is the target already ours (claim landed, or a sibling colony of ours)? Once so,
  // the claim phase is done and the bootstrap phase runs.
  targetClaimed() {
    const t = this.target();
    const room = t && Game.rooms[t.room];
    return !!(room && room.controller && room.controller.my);
  }

  // Has the new colony stood its own economy up? The hand-off line: its first spawn is
  // built AND it has begun spawning its OWN creeps (≥2, for margin), so the pioneer seed
  // can stop and the room runs Stage-1 bootstrap by itself. A built-but-empty spawn with
  // no local creeps yet is NOT self-sufficient — pioneers keep priming it. Needs vision
  // (a pioneer is there); without it we assume not-yet and keep seeding.
  targetSelfSufficient() {
    const t = this.target();
    const room = t && Game.rooms[t.room];
    if (!room || room.find(FIND_MY_SPAWNS).length === 0) return false;
    // Count by colony tag across ALL creeps, not just those currently in-room — a
    // local that steps out (or a bootstrap worker fetching from a neighbour tile)
    // must not drop the count and restart the pioneer seed.
    const locals = Object.values(Game.creeps).filter((c) => c.memory.colony === t.room).length;
    return locals >= 2;
  }

  // Claimers: one until the room is ours (and we have GCL headroom + a healthy home),
  // then none.
  claimerCount() {
    if (!this.active() || this.targetClaimed()) return 0;
    return this.hasGclHeadroom() ? 1 : 0;
  }

  // Pioneers: a fixed seed crew once the room is ours and until its spawn stands. NOT
  // gated on expansionReady — once we've claimed we're committed, so bootstrap flows
  // even if the readiness dial dips; it yields only to a home crisis (recovering).
  pioneerCount() {
    if (!this.target() || !this.targetClaimed() || this.targetSelfSufficient()) return 0;
    if (this.colony.health.recovering) return 0;
    return PIONEER_COUNT;
  }

  // Emit the right body for the active phase — claim first (a room can't bootstrap
  // before it's claimed), then pioneers. Built manually (per-role body + stamped
  // target) like ScoutOverlord/GuardOverlord rather than the base single-role gate.
  generateSpawnRequest() {
    const t = this.target();
    if (!t) return null;

    if (this.colony.creepsWithRole("claimer").length < this.claimerCount()) {
      return {
        priority: this.priority,
        role: "claimer",
        body: Claimer.bodyFor(this.colony.spawnEnergyBudget()),
        memory: {
          role: "claimer",
          colony: this.colony.name,
          overlord: this.identifier,
          claimRoom: { room: t.room, controller: t.controller },
        },
      };
    }
    if (this.colony.creepsWithRole("pioneer").length < this.pioneerCount()) {
      return {
        priority: this.priority,
        role: "pioneer",
        body: Pioneer.bodyFor(this.colony.spawnEnergyBudget()),
        memory: {
          role: "pioneer",
          colony: this.colony.name,
          overlord: this.identifier,
          bootstrapRoom: t.room,
        },
      };
    }
    return null;
  }

  runCreep(creep) {
    if (creep.memory.role === "pioneer") Pioneer.run(creep, this.colony);
    else Claimer.run(creep, this.colony);
  }
}
