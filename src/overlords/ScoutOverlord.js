import { Overlord } from "./Overlord.js";
import { Scout } from "../roles/Scout.js";
import { Hunter } from "../roles/Hunter.js";
import { combatBody } from "../lib/CombatBody.js";
import { Threat } from "../lib/Threat.js";
import { towerFreeRoute } from "../lib/Routing.js";
import { stageAtLeast } from "../lib/Stages.js";
import expansionMap from "../data/expansionMap.json";

// Tunables (ship and observe — we always tune live).
// Self-balancing scout count (#159): a small always-on baseline + a storage-surplus delta, so the
// score fleet scales with the energy inflow-vs-consumption balance (storage level = its integral).
// Tuned aggressive after live observation: rivals field fleets of single-[MOVE] score scouts
// sweeping the highways, so SCORE IS BEING COLLECTED NOW — the original 40k reserve / 20k step / 6
// cap waited for deep surplus and ceded the race. Fund the score fleet from a SMALL cushion, ramp
// FAST, and allow a real fleet. The self-balance still protects the economy: a draining storage
// (economy hungry) collapses the delta straight back to the baseline.
const SCOUT_BASELINE = 2; // always-on scouts for vision + minimal score — the soft floor; the count
// never drops below it except when a hard gate forces 0 (recovery / home attack / pre-2b / no map).
const SCORE_FLEET_RESERVE = 10000; // bank only a small survival cushion before funding score scouts —
// score is the WIN and it's contested now, so don't hoard energy waiting for it.
const ENERGY_PER_SCORE_SCOUT = 10000; // storage surplus above the reserve per extra score scout — a
// faster ramp than before; scouts are dirt cheap ([MOVE], ~50e) so spawn-time, not energy, is the cost.
const SCORE_SCOUT_MAX = 10; // ceiling on the surplus fleet — high enough to actually compete, while
// the storage signal still throttles it down the moment the economy needs the spawn.
const SPAWN_IDLE_SCALE = 20; // scouts per unit of spawn-idle EWMA (#170): a SECOND spare-capacity
// signal — when the spawn isn't continuously spawning, fill the spare cycles with score scouts.
// ~0.5 idle → the cap; ~0 (busy spawn) → 0. Combined with the storage term via MAX, so whichever
// spare-capacity signal is more permissive sets the count. Ship-and-observe.
const SCAN_RADIUS = 6; // BFS room-radius from home to consider (a scout's reach)
const ROUTE_CAP = 8; // max rooms per assigned leg (loose TTL cap; early death frees the tail)
const STALE_MAX = 20000; // staleness cap; a never-seen room uses this as its age
const CLAIMED_PENALTY = 0.1; // another scout's queued room: deprioritise, don't exclude
const SCOUT_THREAT_PENALTY = 0.05; // recently killed a scout / live armed threat: deprioritise hard
const EMPTY_REPLAN_COOLDOWN = 50; // ticks before retrying a plan that came back empty
const BLOCKER_THRESHOLD = 2; // scout casualties in a room before it earns a clearer (#147/#187)
const HUNTER_PRIORITY = 5; // the clearer spawns below economy/defence — clearing a blocker isn't urgent
const SCORE_TILES_PER_ROOM = 50; // rough tiles/room — a [MOVE] scout walks 1 tile/tick, so this
// × room-distance is a FLOOR estimate of travel ticks to weigh against a Score's decay (#24).
const DIVERSION_MARGIN = 100; // slack over that ETA before abandoning a diversion: covers in-room
// depth + avoidHostiles detours. Past it the tile is contested/unreachable — release the scout.
const DIVERSION_COOLDOWN = 200; // after abandoning a Score tile, ignore it this long so the fleet
// doesn't churn onto a tile a rival is camping.

// Room value by type (× staleness = priority). A room with a live ground Score is the prize
// (banking it is the win), so it outranks everything; highways are transit corridors worth
// keeping fresh; then never-seen > player (intel for #140) > plain neutral.
const VALUE = { score: 6, highway: 4, unknown: 3, player: 2, neutral: 1 };

// ============================================================================
//  ScoutOverlord — keeps map intel fresh by roaming cheap scouts (#142).
//
//  Stateless Controller (MVC): the route/claim state lives in the Model
//  (Memory.colonyData[c].scoutRoutes); this overlord, rebuilt each tick, plans /
//  prunes / dispatches against it. Scouts are pure vision-delivery — the Kernel's
//  Threat.observe pass records what they see; the overlord just decides WHERE the
//  next stale room is and routes a scout there.
//
//  Routing: each scout gets a greedy chain of high-priority rooms
//  (priority = staleness × value − danger). Rooms a live scout already owns are
//  claimed, so the next scout fans out elsewhere — no overlap, no idling. Claims
//  are by scout identity and auto-free when a scout leaves assignedCreeps (dead),
//  the GuardOverlord released-guard pattern; no tick-expiry.
//
//  Score diversion (#24): the Kernel's observe pass records ground Score objects into
//  roomIntel; this overlord then diverts the CLOSEST free scout (no diversion yet, not
//  fleeing) to step on a reachable Score tile — banking the points IS the season win — then
//  the scout resumes its route. The win scales with coverage × speed: more scouts + spawns +
//  colonies grab more Score before it decays. A fast [MOVE] scout is already the ideal score
//  creep, so there's no separate collector role.
//
//  Not RCL8-gated (the score race is open now). The count SELF-BALANCES against the economy: a
//  small always-on baseline (vision + minimal score) plus a spare-capacity bonus that funds extra
//  score scouts only when there's slack. The bonus is the MAX of two signals (#159/#166 + #170):
//    • STORAGE LEVEL — the integral of the inflow-vs-consumption balance; surplus → more scouts,
//      draining → collapses to the baseline, freeing the spawn for the economy.
//    • SPAWN IDLENESS — when the spawn stops continuously spawning, fill the spare cycles with
//      scouts (gated until storage holds a buffer, so early-game bootstrap isn't starved).
//  Either way the win scales with coverage × speed. The count is the lever (the spawn model
//  balances by count, not priority-interleave), mirroring the UpgradeOverlord storage-delta (#137).
//  Home defence / recovery / pre-2b / no-map still drop desiredCount to 0.
// ============================================================================
export class ScoutOverlord extends Overlord {
  constructor(colony) {
    // Priority 2 — above haulers (Logistics is 3), alongside Work/Filler (2). Safe to sit here
    // because desiredCount is a small baseline plus a storage-surplus-capped delta (#159) — it
    // only grows the fleet when the economy is banking energy — and a scout is dirt cheap ([MOVE]);
    // it stands down entirely while home is under attack.
    super(colony, { priority: 2 });
  }

  get role() {
    return "scout";
  }

  // Owns two roles: scouts (always) + an optional hunter (#187) — a SOLO clearer dispatched to a
  // persistent winnable blocker (#167) to clear it and re-open the sector, then freeHunt the remotes.
  // No bait-scout pairing: the hunter provides its own vision. One controller, the whole domain.
  get roles() {
    return ["scout", "hunter"];
  }

  // Self-balancing count (#159): the always-on baseline plus a storage-surplus delta.
  // Gated to 0 first (hard overrides, stand fully down): no expansionMap entry (it carries the
  // SK/enemy-core avoid list — no safe routing without it), before Stage 2b, in workforce
  // recovery, or while HOME is under attack (we sit above guards in priority, so stand down to
  // let defence spawn).
  desiredCount() {
    if (!expansionMap[this.colony.name]) return 0;
    if (!stageAtLeast(this.colony, "2b:Hauling")) return 0;
    if (this.colony.health.recovering) return 0;
    if (Threat.isHot(this.colony.name)) return 0;
    // Let logistics bootstrap first (#159 review): scouts sit ABOVE haulers in spawn priority, so
    // spawning the always-on baseline before the first hauler exists would preempt the very hauler
    // that entering 2b spins up to start moving container energy — stalling the economy at the
    // transition. Hold at 0 until energy is actually being hauled.
    const haulers =
      this.colony.creepsWithRole("hauler").length +
      this.colony.creepsWithRole("remoteHauler").length;
    if (haulers === 0) return 0;
    return SCOUT_BASELINE + this.surplusScouts();
  }

  // Extra score scouts from spare capacity — the MAX of two independent signals, capped at
  // SCORE_SCOUT_MAX. Not a sum: both mean "we can afford more scouts", and a banked storage
  // usually co-occurs with an idle spawn, so adding them would double-count. Whichever signal is
  // more permissive sets the bonus.
  //  • storage surplus (#159/#166) — banked energy above a reserve; the economy's inflow-vs-
  //    consumption integral. Draining storage collapses it back to the baseline (economy first).
  //  • spawn idleness (#170) — when the spawn stops continuously spawning, spare cycles → score.
  surplusScouts() {
    const storage = this.colony.room.storage;
    return Math.min(Math.max(this.storageSurplusScouts(storage), this.spawnIdleScouts(storage)), SCORE_SCOUT_MAX);
  }

  // Storage-surplus term: one extra scout per ENERGY_PER_SCORE_SCOUT banked above the reserve.
  // Pre-storage (the 2b→3 window) → 0 (the baseline alone). Read live, not smoothed: the per-scout
  // step dwarfs per-tick storage jitter, so it can't chatter — the reserve doubles as a dead-band
  // (the #137 upgrader-delta idiom). No `recovering` guard: desiredCount returns 0 there first.
  storageSurplusScouts(storage) {
    if (!storage) return 0;
    const surplus = storage.store[RESOURCE_ENERGY] - SCORE_FLEET_RESERVE;
    return Math.max(Math.floor(surplus / ENERGY_PER_SCORE_SCOUT), 0);
  }

  // Spawn-idleness term (#170): a sustained-idle spawn has spare cycles → mint score scouts.
  // colony.health.spawnIdle is the EWMA idle ratio (high = idle; ~0 on a busy spawn, so this is 0
  // while the economy needs the spawn — correct). EARLY-GAME GATE: off until storage is built AND
  // holds energy — before a buffer exists, an idle spawn means BOOTSTRAPPING, not surplus, and
  // chasing scouts would starve it. Scouts are too cheap to drag spawnIdle down, so the
  // SCORE_SCOUT_MAX cap (applied by surplusScouts) is the sole ceiling — it ramps and holds, no
  // oscillation; when the economy reclaims the spawn, spawnIdle falls and this drops away.
  spawnIdleScouts(storage) {
    if (!storage || storage.store[RESOURCE_ENERGY] === 0) return 0;
    return Math.max(Math.floor((this.colony.health.spawnIdle || 0) * SPAWN_IDLE_SCALE), 0);
  }

  // The current persistent winnable blocker (a scout-killer worth clearing), or null. Memoized per tick
  // (findBlocker walks the BFS radius + reads intel). The single source of truth for the hunter's objective.
  blocker() {
    if (this._blocker === undefined) this._blocker = this.findBlocker();
    return this._blocker;
  }

  // Spawn the solo clearer FIRST if a blocker wants one and none is fielded yet, else a scout (counting
  // only scouts — assignedCreeps includes the hunter too). Fully overrides the base count gate.
  generateSpawnRequest() {
    const hunter = this.hunterSpawnRequest();
    if (hunter) return hunter;
    if (this.colony.creepsWithRole("scout").length >= this.desiredCount()) return null;
    return {
      priority: this.priority,
      role: "scout",
      body: Scout.bodyFor(this.colony.spawnEnergyBudget()),
      memory: { role: "scout", colony: this.colony.name, overlord: this.identifier },
    };
  }

  // A solo clearer sized to the blocker's threat — ONE at a time (a freeHunting hunter is re-targeted by
  // run(), not duplicated). Null when there's no blocker, a hunter already exists, or intel went stale.
  hunterSpawnRequest() {
    const blocker = this.blocker();
    if (!blocker) return null;
    if (this.assignedCreeps.some((c) => c.memory.role === "hunter")) return null; // one hunter at a time
    const profile = Threat.profileFor(blocker);
    if (!profile) return null; // intel went stale — don't spawn blind
    return {
      priority: HUNTER_PRIORITY,
      role: "hunter",
      body: combatBody(this.colony.spawnEnergyBudget(), profile),
      memory: {
        role: "hunter",
        colony: this.colony.name,
        overlord: this.identifier,
        target: blocker, // holdPoint clears it; nulled by run() once cleared → freeHunter roams (#187)
        behaviors: Hunter.behaviors, // the role owns its conduct set (#187) — see Hunter.behaviors
      },
    };
  }

  runCreep(creep) {
    if (creep.memory.role === "hunter") Hunter.run(creep, this.colony);
    else Scout.run(creep, this.colony);
  }

  // The route/claim registry — the single source of truth, owned here, walked by scouts.
  get routes() {
    Memory.colonyData ||= {};
    return ((Memory.colonyData[this.colony.name] ||= {}).scoutRoutes ||= {});
  }

  // Recently-abandoned Score tiles (key → expiry tick): tiles a scout couldn't bank in time
  // (a rival is camping it / it's unreachable), kept out of re-assignment for DIVERSION_COOLDOWN
  // so the fleet doesn't churn back onto them. Pruned each pass; self-bounded.
  get scoreCooldown() {
    Memory.colonyData ||= {};
    return ((Memory.colonyData[this.colony.name] ||= {}).scoreCooldown ||= {});
  }

  run() {
    const routes = this.routes;
    const alive = new Set(this.assignedCreeps.map((c) => c.name));
    // Claim-by-liveness: a route whose scout is gone releases its rooms. A dead scout also
    // gets its casualty attributed to the room it fell in (#147) — `creep.memory` is already
    // wiped by the time we run, but the plan's `lastRoom` survives here.
    for (const name in routes) {
      if (alive.has(name)) continue;
      if (routes[name].lastRoom) Threat.bumpScoutThreat(routes[name].lastRoom);
      delete routes[name];
    }
    // Command the hunter (#187): aim it at the current blocker, or null → it freeHunts the remotes
    // (the BehaviorMachine edge does the switch). The same instruction re-targets a freeHunting hunter
    // onto a freshly-detected blocker with no respawn — the WarbandOverlord.command pattern.
    const blocker = this.blocker();
    for (const creep of this.assignedCreeps) {
      if (creep.memory.role === "hunter") creep.memory.target = blocker || null;
    }
    // Divert the closest free scout onto a known, reachable ground Score tile (#24).
    this.manageScoreDiversions(routes);

    // Give every live SCOUT a fresh leg if it has none or finished its last one. A fleeing scout is
    // left alone until safe, then re-planned. An empty plan (no candidates) backs off for a cooldown
    // so we don't re-run the BFS every tick. (The hunter is a solo combat unit — it has no route.)
    for (const creep of this.assignedCreeps) {
      if (creep.memory.role !== "scout") continue;
      if ((creep.memory.fleeUntil || 0) > Game.time) continue; // fleeing — don't touch its route
      const plan = routes[creep.name];
      if (plan?.scoreDiversion) continue; // detouring to a Score — keep its route intact to resume
      if (plan && plan.index < plan.route.length) continue; // still walking its route
      if (plan && plan.route.length === 0 && Game.time - plan.tick < EMPTY_REPLAN_COOLDOWN) continue;
      routes[creep.name] = { route: this.planRoute(creep.pos.roomName), index: 0, tick: Game.time };
    }
    super.run();
  }

  // Score-diversion lifecycle (#24): clear diversions whose Score was banked/decayed, then
  // hand each still-live, reachable Score to the CLOSEST free scout (one Score per scout,
  // de-conflicted so two scouts never chase the same tile). A free scout = a live, routed
  // scout with no diversion yet, and not fleeing. The scout detours via Scout.collectScore,
  // then resumes its route.
  manageScoreDiversions(routes) {
    const cooldown = this.scoreCooldown;
    for (const key in cooldown) if (cooldown[key] <= Game.time) delete cooldown[key]; // prune expired
    // 1. Finish diversions. Past its deadline → abandon (the tile is contested/unreachable, e.g.
    //    a rival camping the live Score) and cool the tile down so the fleet doesn't churn onto
    //    it; else if the Score is gone (banked/decayed) → just clear. The scout also self-clears
    //    on arrival (Scout.collectScore).
    for (const name in routes) {
      const d = routes[name].scoreDiversion;
      if (!d) continue;
      if (Game.time > d.deadline) {
        cooldown[this.scoreKey(d)] = Game.time + DIVERSION_COOLDOWN;
        delete routes[name].scoreDiversion;
      } else if (!this.liveScore(d.room, d.x, d.y)) {
        delete routes[name].scoreDiversion;
      }
    }
    // 2. Tiles already claimed by an active diversion — never double-assign one.
    const taken = new Set(
      Object.values(routes)
        .map((p) => (p.scoreDiversion ? this.scoreKey(p.scoreDiversion) : null))
        .filter(Boolean)
    );
    // 3. Free scouts available to divert.
    const free = this.assignedCreeps.filter(
      (c) =>
        c.memory.role === "scout" &&
        (c.memory.fleeUntil || 0) <= Game.time &&
        routes[c.name] &&
        !routes[c.name].scoreDiversion
    );
    if (!free.length) return;
    // 4. Richest Score first; give each to the nearest scout that can reach it before decay,
    //    skipping claimed or cooled-down tiles. Room-distance picks the nearest scout (dist 0 =
    //    its own room = closest), while the reach/deadline ETA adds +1 room so even an in-room
    //    Score is held to one room's worth of tiles — we never chase one we can't reach in time.
    for (const target of this.knownScores()) {
      if (!free.length) break;
      const key = this.scoreKey(target);
      if (taken.has(key) || cooldown[key]) continue;
      let best = null;
      let bestEta = Infinity;
      for (const c of free) {
        const dist = Game.map.getRoomLinearDistance(c.pos.roomName, target.room);
        const eta = (dist + 1) * SCORE_TILES_PER_ROOM; // +1: always count the destination room
        if (eta >= bestEta) continue;
        if (target.remaining <= eta) continue; // can't arrive before decay
        bestEta = eta;
        best = c;
      }
      if (!best) continue;
      routes[best.name].scoreDiversion = {
        room: target.room,
        x: target.x,
        y: target.y,
        deadline: Game.time + bestEta + DIVERSION_MARGIN,
      };
      taken.add(key);
      free.splice(free.indexOf(best), 1);
    }
  }

  // Every known ground Score still expected alive, richest first. `remaining` discounts the
  // recorded decay by how long ago we last saw the room (we may be en route to a room not yet
  // re-observed), so a long-stale sighting self-expires rather than sending a scout on a
  // wild goose chase.
  knownScores() {
    const out = [];
    const intel = Memory.roomIntel || {};
    for (const room in intel) {
      const seen = intel[room];
      const age = Game.time - (seen.tick || 0);
      for (const s of seen.score || []) {
        const remaining = (s.ticksToDecay || 0) - age;
        if (remaining > 0) out.push({ room, x: s.x, y: s.y, score: s.score || 0, remaining });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Is a Score still believed alive at this tile (latest intel, decay-adjusted)?
  liveScore(room, x, y) {
    const seen = Memory.roomIntel?.[room];
    if (!seen?.score) return false;
    const age = Game.time - (seen.tick || 0);
    return seen.score.some((s) => s.x === x && s.y === y && (s.ticksToDecay || 0) - age > 0);
  }

  // Stable key for a Score tile — de-conflicts diversions (one scout per tile).
  scoreKey(s) {
    return `${s.room}:${s.x}:${s.y}`;
  }

  // The highest-casualty persistent, winnable blocker within reach (or null): a room that has
  // killed scouts ≥ BLOCKER_THRESHOLD times, still holds a mobile threat (fresh combat profile),
  // and that an affordable clearer out-guns by the win-margin (#130). NO highway/score "worth it"
  // filter (#167): Score spawns in EVERY room and a persistent blocker severs a whole sector, so
  // any winnable scout-killer is worth clearing. `winnable` is the real gate (it rejects the
  // un-beatable 800–1600 rooms); `scoutThreatOf` (the casualty count) is the persistence gate.
  // Profile/threat freshness is the INTEL_FRESH_TICKS window, so a long-unobserved room is skipped
  // at the `!profile` check; the narrow window where a threat just left an observed room self-corrects
  // (the hunter's own vision observes it empty → scoutThreat resets → blocker() drops it → freeHunter).
  findBlocker() {
    const budget = this.colony.spawnEnergyBudget();
    let best = null;
    let bestThreat = 0;
    for (const room of this.roomsWithinRadius(this.colony.name, SCAN_RADIUS)) {
      const casualties = Threat.scoutThreatOf(room);
      if (casualties < BLOCKER_THRESHOLD || casualties <= bestThreat) continue;
      const profile = Threat.killableProfile(room); // a mobile threat to kill (not a lone core/tower)
      if (!profile) continue;
      if (!Threat.winnable(combatBody(budget, profile), room)) continue; // winnable now also rejects towers
      best = room;
      bestThreat = casualties;
    }
    return best;
  }

  // Greedy route from a start room: repeatedly pick the best value-per-distance target, then expand
  // that leg into a TOWER-FREE corridor (#194) so the scout walks only vetted rooms and never transits
  // a known-towered one — up to ROUTE_CAP rooms total. Rooms another live scout already queued are kept
  // in the pool but heavily DEPRIORITISED (× CLAIMED_PENALTY), not excluded — so the fleet fans out, yet
  // a scout can still take a uniquely-valuable room (a chokepoint) another claimed rather than be
  // starved; their target sets just diverge. Value-per-distance avoids zig-zags.
  planRoute(fromRoom) {
    const claimed = this.claimedRooms();
    const pool = this.candidateRooms();
    const route = [];
    let cursor = fromRoom;
    while (route.length < ROUTE_CAP && pool.length) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const dist = Game.map.getRoomLinearDistance(cursor, pool[i].room) || 1;
        let score = pool[i].score / dist;
        if (claimed.has(pool[i].room)) score *= CLAIMED_PENALTY;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const target = pool[bestIdx].room;
      pool.splice(bestIdx, 1);
      // Expand the leg into a TOWER-FREE corridor (#194): push every room of the route to the target,
      // so the scout walks only vetted rooms hop-by-hop and never transits a known-towered one. Unscouted
      // rooms stay passable (probing them is the scout's job; a first-probe death is self-correcting).
      // No tower-free path to this target → skip it and try the next.
      const hops = towerFreeRoute(cursor, target, { allowUnscouted: true });
      if (!hops) continue;
      for (const hop of hops) {
        if (route.length >= ROUTE_CAP) break;
        route.push(hop.room);
      }
      // If the cap truncated this corridor mid-way, stop — don't start the next leg from `target` (a
      // room the route never reached), which would insert a non-contiguous, tower-blind jump.
      if (route.length >= ROUTE_CAP) break;
      cursor = target; // full corridor pushed → the route reaches the target; plan the next leg from it
    }
    return route;
  }

  // Every room any live scout still has queued — the claim set the next plan avoids, so two scouts
  // don't pile into the same room (a known harasser included, while it's on a route).
  claimedRooms() {
    const claimed = new Set();
    const routes = this.routes;
    for (const name in routes) {
      const plan = routes[name];
      for (let i = plan.index; i < plan.route.length; i++) claimed.add(plan.route[i]);
    }
    return claimed;
  }

  // Scannable rooms within reach, each scored staleness × value, excluding rooms that
  // are pointless or lethal to enter: our own footprint (already have vision), the
  // offline avoid list (SK / enemy cores), and rooms with known hostile towers.
  candidateRooms() {
    const home = this.colony.name;
    const avoid = new Set((expansionMap[home]?.avoid || []).map((a) => a.room));
    const footprint = new Set([home, ...this.colony.remoteSources().map((s) => s.room)]);
    const out = [];
    for (const room of this.roomsWithinRadius(home, SCAN_RADIUS)) {
      if (footprint.has(room) || avoid.has(room)) continue;
      const intel = Threat.intelFor(room);
      if (intel && intel.towers > 0) continue; // hostile towers → death, no intel gained
      const staleness = Math.min(Game.time - Threat.lastSeen(room), STALE_MAX);
      let score = staleness * this.roomValue(room, intel);
      // #147: deprioritise (not exclude) rooms that recently killed a scout or hold a live
      // armed threat — scouts drain SAFE space first; with the freshness decay these re-open
      // to a cheap re-probe later. Persistent valuable blockers are the hunter's job (#187).
      if (Threat.scoutThreatOf(room) > 0 || Threat.isHot(room)) score *= SCOUT_THREAT_PENALTY;
      out.push({ room, score });
    }
    return out;
  }

  // Value of scanning a room: a live ground Score (the prize — go grab it) > highway corridor
  // > never-seen > a player's room (intel for #140) > plain neutral.
  roomValue(room, intel) {
    if (intel?.score?.length) return VALUE.score;
    if (this.isHighway(room)) return VALUE.highway;
    if (!intel) return VALUE.unknown;
    if (intel.owner || intel.reserver) return VALUE.player;
    return VALUE.neutral;
  }

  // A highway / sector-border room: a coordinate divisible by 10 (E10S7, E15S20, …) — a
  // transit corridor a scout passes through to reach many rooms quickly.
  isHighway(room) {
    const m = /^[WE](\d+)[NS](\d+)$/.exec(room);
    return !!m && (Number(m[1]) % 10 === 0 || Number(m[2]) % 10 === 0);
  }

  // Breadth-first set of rooms within `radius` map-hops of `start`, via the live exit
  // graph (skips map edges / missing rooms automatically). Excludes the start itself.
  roomsWithinRadius(start, radius) {
    const seen = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < radius; depth++) {
      const next = [];
      for (const room of frontier) {
        const exits = Game.map.describeExits(room) || {};
        for (const dir in exits) {
          const neighbour = exits[dir];
          if (!seen.has(neighbour)) {
            seen.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
    seen.delete(start);
    return seen;
  }
}
