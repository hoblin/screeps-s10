import { Overlord } from "./Overlord.js";
import { Guard } from "../roles/Guard.js";
import { Threat } from "../lib/Threat.js";
import { towerFreeRoute } from "../lib/Routing.js";

// Retaliation tunables (#140 — sunk-asset offence; ship and observe).
const RETALIATE_FRESH = 1000; // a target room's intel must be this fresh (ticks) for deniable() to trust it
const RETALIATE_TILES_PER_ROOM = 50; // rough tiles/room → travel ticks for the TTL gate
const RETALIATE_MIN_DENY = 100; // remaining life the guard needs AFTER arrival to do real damage
const RETALIATE_SCAN_INTERVAL = 25; // ticks between target searches for an idle guard (findRoute is
// not free; an attacker with no reachable deniable room shouldn't cost a full scan every tick)

// The guard's behaviour set — a thin state machine over a defend default (the role carries no conduct):
//   holdPoint (default) garrison the assigned room · holdGround hold the spot after a fight (#160) ·
//   raidRoom deny a locked attacker's remote (#140) · freeHunter roam+kill when released (#187/#197,
//   instead of recycling). The overlord steers it by stamping memory.target / memory.targetOwner.
const GUARD_BEHAVIORS = { default: "holdPoint", nodes: ["raidRoom", "holdGround", "freeHunter"] };

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
  // the room's assessed threat by WIN_MARGIN (#130 — a comfortable margin, not a coin-
  // flip). Reads intel (threat + profile) — no live vision needed, it was recorded when
  // a creep last saw the room. Memoized per tick.
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
      return Threat.winnable(Guard.bodyFor(budget, profile), room);
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
      this.assignedCreeps.map((c) => c.memory.target).filter((r) => r && want.has(r))
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
        target: room, // the behaviours (holdPoint/raidRoom/freeHunter) read memory.target, not guardRoom
        behaviors: GUARD_BEHAVIORS,
      },
    };
  }

  // Release a guard ONLY when its room has left our footprint (no longer home, not in the
  // remoteSources map) — then we DROP its target so it becomes a freeHunter (roams the remaining
  // remotes killing hostiles), NEVER recycling it (#197 — a combat unit is never sent home to idle
  // or die in transit; denying the area beats reclaiming one body's energy). A guard whose room
  // merely cooled is NOT released: it garrisons there (#128), counting as coverage so we don't
  // dispatch a duplicate.
  run() {
    const footprint = new Set([
      this.colony.name,
      ...this.colony.remoteSources().map((s) => s.room),
    ]);
    for (const creep of this.assignedCreeps) {
      this.manageRetaliation(creep); // sunk-asset offence (#140) — may redirect an idle guard
      // Drop the target of a guard whose room left our footprint → it becomes a freeHunter. A
      // retaliation (targetOwner set) targets an off-footprint remote by design, so it's exempt.
      if (creep.memory.target && !footprint.has(creep.memory.target) && !creep.memory.targetOwner) {
        creep.memory.target = null;
      }
    }
    super.run();
  }

  // Sunk-asset retaliation (#140): an idle GARRISONING guard — one whose room has cooled, so it's
  // standing around (#128) — goes and denies the attacker's economy for free (zero marginal spawn).
  // The attacker is the owner of the last ARMED hostile this guard fought (stamped by the Engage atom).
  // Defence > offence: it only dispatches once its OWN room is cleaned, and a HOME threat recalls it
  // (the core can't wait on a spawn). A REMOTE re-heat does NOT recall — a fresh guard spawns for the
  // hot remote, cleans it, then joins the offensive, so a persistent harasser mints a self-amplifying
  // STREAM of guards toward his remotes (free, no extra logic; self-limits when he pulls back). Live
  // roomIntel only — scouts keep owner/reserver/towers fresh map-wide (#142), so no baked map needed.
  manageRetaliation(creep) {
    const onMission = !!creep.memory.targetOwner; // a locked attacker = the retaliation signal (raidRoom edge)
    // Recall to defend the CORE the instant home is threatened — gated on isHot (NOT homeTarget,
    // which adds an affordability check): recall is free (an existing guard), so we want it most in
    // the low-energy/recovery case where we couldn't even afford a fresh home defender.
    if (onMission && Threat.isHot(this.colony.name)) {
      creep.memory.target = this.colony.name;
      creep.memory.targetOwner = null;
      return;
    }
    // A REMOTE re-heating does NOT recall — the guard stays on the offensive, and the overlord
    // spawns a FRESH guard for the hot remote (it's an uncovered target). That fresh guard cleans
    // then joins the offensive, so a persistent harasser mints a self-amplifying STREAM of guards
    // toward his remotes — free, no extra logic, and self-limiting once he pulls back to defend.
    if (onMission) {
      // Keep the mission only while the target is still a deniable room of that attacker (he may
      // have left / built a tower since — re-confirmed as our vision refreshes the intel).
      if (!this.deniable(creep.memory.target, creep.memory.foughtOwner, creep)) {
        creep.memory.target = this.colony.name;
        creep.memory.targetOwner = null;
      }
      return;
    }
    // No mission: only an IDLE guard whose OWN room is already CLEANED (on its post, cooled to
    // not-hot) with a remembered armed attacker may go on the offensive. Find that attacker's
    // nearest deniable remote it can reach in time.
    if (creep.room.name !== creep.memory.target) return; // still in transit to its post (or a freeHunter, target null)
    if (Threat.isHot(creep.memory.target)) return; // own room still hot — clean it first
    const owner = creep.memory.foughtOwner;
    if (!owner) return;
    // Rate-limit the findRoute-heavy target search: an idle guard with no reachable deniable room
    // re-scans only every RETALIATE_SCAN_INTERVAL ticks, not every tick.
    if (Game.time - (creep.memory.retScan || 0) < RETALIATE_SCAN_INTERVAL) return;
    creep.memory.retScan = Game.time;
    const target = this.retaliationTarget(owner, creep);
    if (target) {
      creep.memory.target = target; // raidRoom (targetOwner set) carries it there, hunting en route
      creep.memory.targetOwner = owner;
    }
  }

  // The nearest reachable, winnable, tower-free room owned/reserved by `owner` that this guard can
  // reach AND still have life to damage — or null. Only a guard's own deniable candidates trigger a
  // (cost-bearing) route search, so this stays cheap.
  retaliationTarget(owner, creep) {
    const intel = Memory.roomIntel || {};
    let best = null;
    let bestLen = Infinity;
    for (const room in intel) {
      if (!this.deniable(room, owner, creep)) continue;
      const route = towerFreeRoute(creep.room.name, room);
      if (!route || route.length >= bestLen) continue;
      const travel = route.length * RETALIATE_TILES_PER_ROOM;
      if ((creep.ticksToLive || CREEP_LIFE_TIME) < travel + RETALIATE_MIN_DENY) continue; // can't arrive + act
      bestLen = route.length;
      best = room;
    }
    return best;
  }

  // Is `room` a deniable target of `owner`: his (owned or reserved) room, tower-free, fresh intel,
  // and winnable by this guard's current body.
  deniable(room, owner, creep) {
    if (!owner) return false;
    const intel = Memory.roomIntel?.[room];
    if (!intel || Game.time - intel.tick > RETALIATE_FRESH) return false;
    if (intel.towers > 0) return false;
    if (intel.owner !== owner && intel.reserver !== owner) return false;
    return Threat.winnableBy(creep, room);
  }

  runCreep(creep) {
    Guard.run(creep, this.colony);
  }
}
