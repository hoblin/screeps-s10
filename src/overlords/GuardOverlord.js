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

// ============================================================================
//  GuardOverlord — owns the combat-clearing domain (#118, Levels 2-3 of the
//  threat ladder; home defense added in #122). A cheap enemy harasser can deny a
//  remote room and kill our static economy creeps; passive retreat (#105, Level 1)
//  only reroutes and abandons the room. This controller dispatches dynamically-built
//  Guards to clear contested rooms, HOME first, then a founded child colony, then remotes.
//
//  Singleton domain controller (mirrors RemoteMiningOverlord), reading the shared
//  Threat intel. Priority ladder + gating (#122 — defense is the GATE for expansion,
//  so it outranks the economy, NOT the other way round):
//   • HOME (top priority): if the home room has a real combat threat, field the best
//     AFFORDABLE guard unconditionally — no winnability filter (never abandon the
//     core; even a losing guard buys time + tower focus), no expansionReady gate, no
//     recovering veto. Defending the core is the survival floor.
//   • FOUNDED CHILD (#233): a colony WE founded (Memory.expansion.claimTarget.home) that can't yet
//     defend itself (no tower) — an OWNED room outside the remote set. Defended WINNABLE-gated and
//     ahead of remotes (losing a fresh claim wastes the whole founding effort), but it waits out a
//     recovery. Includes razing dismantlers AND declaimers (Threat flags a hostile WORK/CLAIM creep
//     in an owned room — harmless to creeps, lethal to the colony).
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
      // Need a MOBILE enemy a guard can kill (not a lone core/tower — clearing those is a later
      // capability); winnable then also rejects a towered room (assess folds tower danger into threat).
      const profile = Threat.killableProfile(room);
      return !!profile && Threat.winnable(Guard.bodyFor(budget, profile), room);
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
    const profile = Threat.killableProfile(home); // a mobile threat to kill (not a lone core/tower)
    if (!profile) return null;
    const body = Guard.bodyFor(this.colony.spawnEnergyBudget(), profile);
    return Threat.guardCombatPower(body) > 0 ? home : null;
  }

  // The founded CHILD colony as a guard target, or null (#233). A freshly-claimed colony in bootstrap
  // can't field its own guard (no spawn) or auto-defend (no tower), and it's an OWNED room — OUTSIDE the
  // remote set hotWinnableRooms scans — so its FOUNDER must cover it until it can defend itself. The link
  // is Memory.expansion.claimTarget.home (the founder's colony name, the same coupling ClaimOverlord uses).
  // WINNABLE-gated, UNLIKE home: a child is recoverable (re-found), so we don't feed a guard to an army
  // camped on it — but a lone dismantler/harasser reads trivially winnable and gets cleared. The guard
  // reaches it via the swamp-aware routeToRoom (#230). Threat detection for a hostile dismantler/declaimer
  // in the owned child lives in Threat.assess (the +1-per-raser/declaimer in owned rooms).
  foundedChildTarget() {
    const t = Memory.expansion?.claimTarget;
    if (!t || !t.room) return null;
    if ((t.home || this.colony.name) !== this.colony.name) return null; // not a child WE founded
    const child = t.room;
    if (this.childSelfDefends(child)) return null; // it has its own tower now → its GuardOverlord covers it
    if (!Threat.isHot(child)) return null;
    const profile = Threat.killableProfile(child); // a mobile threat a guard can kill (incl. a dismantler)
    if (!profile) return null;
    const body = Guard.bodyFor(this.colony.spawnEnergyBudget(), profile);
    return Threat.guardCombatPower(body) > 0 && Threat.winnable(body, child) ? child : null;
  }

  // Can the founded child defend itself yet? True once it has a TOWER (its own auto-defense; by then it
  // also fields its own guards) — the founder then stops covering it. No vision (no creep there) → assume
  // NOT yet (keep covering); with no vision there's no fresh threat intel anyway, so isHot gates the
  // actual dispatch. A tower (RCL3) is the capability line — stopping earlier (at first spawn) would just
  // re-expose the colony to the spawn-raze cycle this feature exists to break.
  childSelfDefends(child) {
    const room = Game.rooms[child];
    if (!room) return false;
    return room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER }).length > 0;
  }

  // Every room wanting a guard, HOME FIRST, then the founded child, then winnable remotes. Memoized per tick.
  targets() {
    if (this._targets !== undefined) return this._targets;
    const out = [];
    const home = this.homeTarget();
    if (home) out.push(home);
    // The founded child and contested remotes both wait out a workforce-collapse recovery (the founder has
    // no spare guard then) and are NOT expansionReady-gated. The child precedes remotes: losing a fresh
    // claim wastes the whole founding effort, so it's defended ahead of remote economy (defense gates
    // expansion, #122).
    if (!this.colony.health.recovering) {
      const child = this.foundedChildTarget();
      if (child && child !== home) out.push(child);
      for (const room of this.hotWinnableRooms()) if (room !== home && room !== child) out.push(room);
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
        target: room, // the behaviours (holdPoint default, raidRoom on retaliation) read memory.target
        behaviors: Guard.behaviors, // the role owns its conduct set (#187) — see Guard.behaviors
      },
    };
  }

  // A guard is NEVER released to idle/recycle (#197): once dispatched it commits to its remote and
  // holds it until death, denying mining resumption there (the sunk asset stays fully employed). The
  // only re-tasking is sunk-asset retaliation (#140) — manageRetaliation may redirect a guard whose
  // own room has cooled to go deny the attacker's remote instead (still a stay-and-deny, just his room).
  run() {
    for (const creep of this.assignedCreeps) this.manageRetaliation(creep);
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
    if (creep.room.name !== creep.memory.target) return; // still in transit to its post
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

  // Is `room` a deniable target of `owner`: his (owned or reserved) room, fresh intel, and winnable by
  // this guard's current body — winnability now folds in tower danger (assess counts towers), so a
  // towered room reads unwinnable and is rejected here without a separate `towers > 0` check.
  deniable(room, owner, creep) {
    if (!owner) return false;
    const intel = Memory.roomIntel?.[room];
    if (!intel || Game.time - intel.tick > RETALIATE_FRESH) return false;
    if (intel.owner !== owner && intel.reserver !== owner) return false;
    return Threat.winnableBy(creep, room);
  }

  runCreep(creep) {
    Guard.run(creep, this.colony);
  }
}
