import { Overlord } from "./Overlord.js";
import { Scout } from "../roles/Scout.js";
import { Escort } from "../roles/Escort.js";
import { Guard } from "../roles/Guard.js";
import { Threat } from "../lib/Threat.js";
import { stageAtLeast } from "../lib/Stages.js";
import expansionMap from "../data/expansionMap.json";

// Tunables (ship and observe — we always tune live).
// Self-balancing scout count (#159): a small always-on baseline + a storage-surplus delta, so the
// score fleet scales with the energy inflow-vs-consumption balance (storage level = its integral).
const SCOUT_BASELINE = 2; // always-on scouts for vision + minimal score — the soft floor; the count
// never drops below it except when a hard gate forces 0 (recovery / home attack / pre-2b / no map).
const SCORE_FLEET_RESERVE = 40000; // bank this storage cushion before funding any EXTRA score scout
// — a higher cushion than the upgrader reserve (#137, 20k), so the score fleet grows only once
// storage banks well above the level that first feeds extra upgraders (the two then scale together;
// scouts cost ~nothing in energy, so the real coupling is spawn-time, not the shared storage).
const ENERGY_PER_SCORE_SCOUT = 20000; // storage surplus above the reserve per extra score scout. A
// LARGE step (slow climb): scouts cost ~nothing in energy, so the loop closes via spawn-time
// competition, not energy drain — a small step would outrun that loose feedback.
const SCORE_SCOUT_MAX = 6; // cap on the surplus bonus so the single spawn isn't swamped.
const SCAN_RADIUS = 6; // BFS room-radius from home to consider (a scout's reach)
const ROUTE_CAP = 8; // max rooms per assigned leg (loose TTL cap; early death frees the tail)
const STALE_MAX = 20000; // staleness cap; a never-seen room uses this as its age
const CLAIMED_PENALTY = 0.1; // another scout's queued room: deprioritise, don't exclude
const SCOUT_THREAT_PENALTY = 0.05; // recently killed a scout / live armed threat: deprioritise hard
const EMPTY_REPLAN_COOLDOWN = 50; // ticks before retrying a plan that came back empty
const ESCORT_THRESHOLD = 2; // scout casualties in a room before it earns a guard escort (#147)
const ESCORT_PRIORITY = 5; // escort spawns below economy/defence — clearing a blocker isn't urgent
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
//  roomIntel; this overlord then diverts the CLOSEST free scout (no escort mission, not
//  fleeing) to step on a reachable Score tile — banking the points IS the season win — then
//  the scout resumes its route. The win scales with coverage × speed: more scouts + spawns +
//  colonies grab more Score before it decays. A fast [MOVE] scout is already the ideal score
//  creep, so there's no separate collector role.
//
//  Not RCL8-gated (the score race is open now). The count SELF-BALANCES against the economy by
//  STORAGE LEVEL (#159) — storage is the integral of the energy inflow-vs-consumption balance, so
//  a small always-on baseline (vision + minimal score) plus a storage-surplus delta funds extra
//  score scouts only when energy is genuinely banking. Storage draining collapses the delta back
//  to the baseline, freeing the single spawn for the economy (the win waits for the economy to
//  recover); surplus building grows the score fleet — coverage × speed. The count is the lever
//  (the spawn model balances by count, not priority-interleave), mirroring the UpgradeOverlord
//  storage-delta (#137). Home defence / recovery / pre-2b / no-map still drop desiredCount to 0.
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

  // Owns two roles: scouts (always) + an optional escort (#147) — a guard that follows a
  // mission scout to clear a persistent winnable blocker so a valuable room re-opens to
  // scouting. One controller, the whole domain — no cross-overlord coordination.
  get roles() {
    return ["scout", "escort"];
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
    return SCOUT_BASELINE + this.surplusScouts();
  }

  // Extra score scouts proportional to the banked storage surplus above a reserve, capped (#159).
  // Storage level is the integral of the energy inflow-vs-consumption balance, so the count tracks
  // it: surplus building → more scouts; storage draining → the delta collapses to the baseline,
  // freeing the spawn for the economy. Pre-storage (the 2b→3 window) → 0, so the count is the
  // baseline alone until storage exists. Read live, not smoothed: the per-scout energy step
  // (ENERGY_PER_SCORE_SCOUT) dwarfs per-tick storage jitter, so the count can't chatter — the
  // reserve doubles as a dead-band (same anti-chatter idiom as the #137 upgrader delta). No
  // separate `recovering` guard: desiredCount already returns 0 there before this runs.
  surplusScouts() {
    const storage = this.colony.room.storage;
    if (!storage) return 0;
    const surplus = storage.store[RESOURCE_ENERGY] - SCORE_FLEET_RESERVE;
    return Math.min(Math.max(Math.floor(surplus / ENERGY_PER_SCORE_SCOUT), 0), SCORE_SCOUT_MAX);
  }

  // Spawn an escort FIRST if a mission scout needs a bodyguard, else a scout (counting only
  // scouts — assignedCreeps now includes escorts too). Fully overrides the base count gate.
  generateSpawnRequest() {
    const escort = this.escortSpawnRequest();
    if (escort) return escort;
    if (this.colony.creepsWithRole("scout").length >= this.desiredCount()) return null;
    return {
      priority: this.priority,
      role: "scout",
      body: Scout.bodyFor(this.colony.spawnEnergyBudget()),
      memory: { role: "scout", colony: this.colony.name, overlord: this.identifier },
    };
  }

  // A guard sized to the blocker's threat for a mission scout that lacks a live escort.
  escortSpawnRequest() {
    const mission = Object.entries(this.routes).find(([, p]) => p.escortMission);
    if (!mission) return null;
    const [scoutName, plan] = mission;
    if (!Game.creeps[scoutName]) return null; // the scout must be alive to be followed
    const covered = this.assignedCreeps.some(
      (c) => c.memory.role === "escort" && c.memory.escortScout === scoutName
    );
    if (covered) return null;
    const profile = Threat.profileFor(plan.escortMission);
    if (!profile) return null; // intel went stale — don't spawn blind
    return {
      priority: ESCORT_PRIORITY,
      role: "escort",
      body: Guard.bodyFor(this.colony.spawnEnergyBudget(), profile),
      memory: {
        role: "escort",
        colony: this.colony.name,
        overlord: this.identifier,
        escortScout: scoutName,
        guardType: Guard.counterType(profile),
      },
    };
  }

  runCreep(creep) {
    if (creep.memory.role === "escort") Escort.run(creep, this.colony);
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
    // Detect a persistent winnable blocker and (re)assign the escort mission (#147).
    this.manageEscortMission(routes);
    // Divert the closest free scout onto a known, reachable ground Score tile (#24).
    this.manageScoreDiversions(routes);

    // Give every live SCOUT a fresh leg if it has none or finished its last one (escorts
    // have no route — they follow their scout). A mission scout is forced onto the blocker
    // until it's cleared. A fleeing scout is left alone until safe, then re-planned. An empty
    // plan (no candidates) backs off for a cooldown so we don't re-run the BFS every tick.
    for (const creep of this.assignedCreeps) {
      if (creep.memory.role !== "scout") continue;
      if ((creep.memory.fleeUntil || 0) > Game.time) continue; // fleeing — don't touch its route
      const plan = routes[creep.name];
      if (plan?.escortMission) {
        const onBlocker = plan.route.length === 1 && plan.route[0] === plan.escortMission;
        if (onBlocker && plan.index < plan.route.length) continue; // still heading to the blocker
        routes[creep.name] = { route: [plan.escortMission], index: 0, tick: Game.time, escortMission: plan.escortMission };
        continue;
      }
      if (plan?.scoreDiversion) continue; // detouring to a Score — keep its route intact to resume
      if (plan && plan.index < plan.route.length) continue; // still walking its route
      if (plan && plan.route.length === 0 && Game.time - plan.tick < EMPTY_REPLAN_COOLDOWN) continue;
      routes[creep.name] = { route: this.planRoute(creep.pos.roomName), index: 0, tick: Game.time };
    }
    super.run();
  }

  // Escort-mission lifecycle (#147): clear a mission once its blocker is cleared (scoutThreat
  // back to 0), and — if none is active and a persistent winnable blocker exists — assign it
  // to a live scout (one mission at a time). The forced route + the spawned escort then do
  // the work; `escortSpawnRequest` reads the mission to field the bodyguard.
  manageEscortMission(routes) {
    for (const name in routes) {
      const blocker = routes[name].escortMission;
      if (blocker && Threat.scoutThreatOf(blocker) === 0) delete routes[name].escortMission;
    }
    if (Object.values(routes).some((p) => p.escortMission)) return; // one mission at a time
    const blocker = this.findBlocker();
    if (!blocker) return;
    const scout = this.assignedCreeps.find(
      (c) => c.memory.role === "scout" && routes[c.name] && !routes[c.name].escortMission
    );
    if (scout) routes[scout.name].escortMission = blocker;
  }

  // Score-diversion lifecycle (#24): clear diversions whose Score was banked/decayed, then
  // hand each still-live, reachable Score to the CLOSEST free scout (one Score per scout,
  // de-conflicted so two scouts never chase the same tile). A free scout = a live, routed
  // scout with no escort mission, no diversion yet, and not fleeing. The scout detours via
  // Scout.collectScore, then resumes its route. Mirrors manageEscortMission, but a diversion
  // is transient (grab one tile and resume) where an escort mission is sustained.
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
        !routes[c.name].escortMission &&
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

  // The best persistent, winnable, VALUABLE blocker within reach (or null): a room that has
  // killed scouts ≥ ESCORT_THRESHOLD times, is worth scouting (highway/score), still holds a
  // mobile threat, and that an affordable escort out-guns by the win-margin (#130).
  findBlocker() {
    const budget = this.colony.spawnEnergyBudget();
    let best = null;
    let bestThreat = 0;
    for (const room of this.roomsWithinRadius(this.colony.name, SCAN_RADIUS)) {
      const casualties = Threat.scoutThreatOf(room);
      if (casualties < ESCORT_THRESHOLD || casualties <= bestThreat) continue;
      if (!this.worthEscorting(room)) continue;
      const profile = Threat.profileFor(room);
      if (!profile || profile.attack + profile.ranged === 0) continue; // need a creep to kill
      if (!Threat.winnable(Guard.bodyFor(budget, profile), room)) continue;
      best = room;
      bestThreat = casualties;
    }
    return best;
  }

  // Only escort into rooms whose intel is worth the spawn: highway corridors / rooms with a
  // known ground Score worth grabbing.
  worthEscorting(room) {
    return this.isHighway(room) || !!Threat.intelFor(room)?.score?.length;
  }

  // Greedy route from a start room: repeatedly hop to the best value-per-distance room,
  // up to ROUTE_CAP. Rooms another live scout already queued are kept in the pool but
  // heavily DEPRIORITISED (× CLAIMED_PENALTY), not excluded — so the fleet fans out, yet
  // a scout can still take a uniquely-valuable room (a chokepoint) another claimed rather
  // than be starved; their target sets just diverge. Value-per-distance avoids zig-zags.
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
      cursor = pool[bestIdx].room;
      route.push(cursor);
      pool.splice(bestIdx, 1);
    }
    return route;
  }

  // Every room any live scout still has queued — the claim set the next plan avoids. A
  // mission scout's blocker is claimed for the WHOLE mission (not just while it's queued in
  // the route): on arrival the scout sits at index === route.length, which would otherwise
  // drop the claim for a tick and let another scout get routed into the harasser.
  claimedRooms() {
    const claimed = new Set();
    const routes = this.routes;
    for (const name in routes) {
      const plan = routes[name];
      for (let i = plan.index; i < plan.route.length; i++) claimed.add(plan.route[i]);
      if (plan.escortMission) claimed.add(plan.escortMission);
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
      // to a cheap re-probe later. Persistent valuable blockers are the escort half's job.
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
