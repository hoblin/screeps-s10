import { Overlord } from "./Overlord.js";
import { Claimer } from "../roles/Claimer.js";
import { Pioneer } from "../roles/Pioneer.js";
import { behaviorClass } from "../behaviors/index.js";
import { assignBuildTargets } from "./buildTargets.js";

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
//       pioneers from home to build its first spawn AND fill/upgrade it through the whole
//       fragile RCL1→3 cold start (#242), concentrating them on the child's sites (the same
//       command pattern WorkOverlord uses); stop once the child reaches RCL3 and can field
//       its own towers + economy.
//
//  Gated like the other expansion overlords on home-economy health (expansionReady),
//  plus GCL headroom (can't claim past Game.gcl.level) and "target still unowned".
//  Priority 2 — below the home core (mining/filler/defense) and home builders, but ABOVE
//  the remote economy (remote mining/reserve/haul): a 2nd base compounds the economy more
//  than one extra local remote, so expansion spawns ahead of the remotes (ordered before
//  RemoteMiningOverlord in Colony for the same-tier tie-break). This also stops a one-shot
//  claimer from starving behind a saturated single spawn (#220 follow-up).
// ============================================================================

// Seed crew that builds the first spawn and accelerates the new colony through its RCL1→3 cold
// start (#242). A handful is plenty — they self-harvest a fresh room's two sources, and the work is
// finite (stops once the child reaches RCL3 and stands on its own towers + economy).
const PIONEER_COUNT = 3;

export class ClaimOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 2 }); // above the remote economy, below the home core (#220 follow-up)
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

  // The bootstrap hand-off line: the child has reached RCL3. By then it can build a tower and run a
  // basic economy with its own miners/haulers/workers, so the imported pioneer seed can stop — the
  // colony stands on its own. Streaming pioneers through the WHOLE RCL1→3 climb (not just to first-
  // spawn) is the #242 accelerator: a rich home compounds the new colony fast over its slowest phase.
  // Needs vision (a pioneer is there); without it we assume not-yet and keep seeding.
  childReachedRcl3() {
    const t = this.target();
    const room = t && Game.rooms[t.room];
    return !!(room && room.controller && room.controller.level >= 3);
  }

  // Claimers: one until the room is ours (and we have GCL headroom + a healthy home),
  // then none.
  claimerCount() {
    if (!this.active() || this.targetClaimed()) return 0;
    return this.hasGclHeadroom() ? 1 : 0;
  }

  // Pioneers: a fixed seed crew once the room is ours and until the child reaches RCL3. NOT
  // gated on expansionReady — once we've claimed we're committed, so bootstrap flows
  // even if the readiness dial dips; it yields only to a home crisis (recovering).
  pioneerCount() {
    if (!this.target() || !this.targetClaimed() || this.childReachedRcl3()) return 0;
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
        // Body lives on the conduct (the model owns it, #239): read it off the pioneer behaviour
        // rather than the role, and stamp the behaviour set so the BehaviorMachine drives it.
        role: "pioneer",
        body: behaviorClass(Pioneer.behaviors.default).bodyFor(this.colony.spawnEnergyBudget()),
        memory: {
          role: "pioneer",
          colony: this.colony.name,
          overlord: this.identifier,
          bootstrapRoom: t.room,
          behaviors: Pioneer.behaviors,
        },
      };
    }
    return null;
  }

  // Concentrate the pioneer seed on the child's construction sites BEFORE driving them, so each
  // Build atom sees a fresh memory.buildTarget the same tick — the same command pattern WorkOverlord
  // runs over its home room (shared assignBuildTargets), here over the bootstrapping child (#242).
  run() {
    this.assignPioneerBuildTargets();
    super.run();
  }

  // Stamp build targets across the pioneers standing in the child room. Vision-guarded: we only see
  // the child's sites once a pioneer has arrived — until then Build no-ops and BuildSpawn still self-
  // scans the spawn site, so the cold start is never blocked on assignment. (The spawn site is excluded
  // from assignment — it's BuildSpawn's job; pioneers converge on it naturally as the singular target.)
  assignPioneerBuildTargets() {
    const t = this.target();
    const room = t && Game.rooms[t.room];
    if (!room) return;
    const pioneers = this.assignedCreeps.filter(
      (c) => c.memory.role === "pioneer" && !c.spawning && c.room.name === t.room
    );
    assignBuildTargets(pioneers, room.find(FIND_MY_CONSTRUCTION_SITES));
  }

  runCreep(creep) {
    if (creep.memory.role === "pioneer") Pioneer.run(creep, this.colony);
    else Claimer.run(creep, this.colony);
  }
}
