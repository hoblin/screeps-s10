import { Overlord } from "./Overlord.js";
import { Scout } from "../roles/Scout.js";
import { Threat } from "../lib/Threat.js";
import { stageAtLeast } from "../lib/Stages.js";
import expansionMap from "../data/expansionMap.json";

// Tunables (ship and observe — we always tune live).
const DESIRED_SCOUTS = 2; // small continuous fleet
const SCAN_RADIUS = 6; // BFS room-radius from home to consider (a scout's reach)
const ROUTE_CAP = 8; // max rooms per assigned leg (loose TTL cap; early death frees the tail)
const STALE_MAX = 20000; // staleness cap; a never-seen room uses this as its age
const CLAIMED_PENALTY = 0.1; // another scout's queued room: deprioritise, don't exclude
const EMPTY_REPLAN_COOLDOWN = 50; // ticks before retrying a plan that came back empty

// Room value by type (× staleness = priority). Score structures are the prize, so their
// rooms outrank everything; a known collector (a banking site) is kept freshest of all.
const VALUE = { collector: 6, highway: 4, unknown: 3, player: 2, neutral: 1 };

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
//  Not RCL8-gated (the score race is open now): the LOW overlord priority IS the
//  spare-capacity gate — a scout spawns only when nothing more important wants the
//  single spawn (a spawn-idle latch chronically falses on a busy spawn).
// ============================================================================
export class ScoutOverlord extends Overlord {
  constructor(colony) {
    // Priority 8: below all economy (≤5) and defence (4) — scouts take the spawn only
    // in genuine gaps, so they never compete with anything that matters.
    super(colony, { priority: 8 });
  }

  get role() {
    return "scout";
  }

  // Scout once the economy is self-sustaining (Stage 2b) and we're not in crisis. The
  // count is flat; the priority gate (not a health latch) decides when one actually spawns.
  // Requires an expansionMap entry: it carries the SK/enemy-core avoid list, without which
  // we can't route scouts safely — so no map entry (e.g. an unscanned room) ⇒ no scouts.
  desiredCount() {
    if (!expansionMap[this.colony.name]) return 0;
    if (!stageAtLeast(this.colony, "2b:Hauling")) return 0;
    if (this.colony.health.recovering) return 0;
    return DESIRED_SCOUTS;
  }

  bodyFor(energyBudget) {
    return Scout.bodyFor(energyBudget);
  }

  runCreep(creep) {
    Scout.run(creep, this.colony);
  }

  // The route/claim registry — the single source of truth, owned here, walked by scouts.
  get routes() {
    Memory.colonyData ||= {};
    return ((Memory.colonyData[this.colony.name] ||= {}).scoutRoutes ||= {});
  }

  run() {
    const routes = this.routes;
    const alive = new Set(this.assignedCreeps.map((c) => c.name));
    // Claim-by-liveness: a route whose scout is gone releases its rooms (just delete it).
    for (const name in routes) if (!alive.has(name)) delete routes[name];
    // Give every live scout a fresh leg if it has none or finished its last one. An empty
    // plan (no candidates this tick) backs off for a cooldown so we don't re-run the BFS
    // every tick for a scout that has nowhere to go.
    for (const creep of this.assignedCreeps) {
      const plan = routes[creep.name];
      if (plan && plan.index < plan.route.length) continue; // still walking its route
      if (plan && plan.route.length === 0 && Game.time - plan.tick < EMPTY_REPLAN_COOLDOWN) continue;
      routes[creep.name] = { route: this.planRoute(creep.pos.roomName), index: 0, tick: Game.time };
    }
    super.run();
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

  // Every room any live scout still has queued — the claim set the next plan avoids.
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
      out.push({ room, score: staleness * this.roomValue(room, intel) });
    }
    return out;
  }

  // Value of scanning a room: a known banking site (collector) > highway (where score
  // structures spawn) > never-seen > a player's room (intel for #140) > plain neutral.
  roomValue(room, intel) {
    if (intel?.collectors?.length) return VALUE.collector;
    if (this.isHighway(room)) return VALUE.highway;
    if (!intel) return VALUE.unknown;
    if (intel.owner || intel.reserver) return VALUE.player;
    return VALUE.neutral;
  }

  // A highway / sector-border room: a coordinate divisible by 10 (E10S7, E15S20, …),
  // where ScoreContainers spawn and ScoreCollectors live.
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
