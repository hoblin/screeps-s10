import { Overlord } from "./Overlord.js";
import { RemoteHauler } from "../roles/RemoteHauler.js";
import { Hauler } from "../roles/Hauler.js";
import { Miner } from "../roles/Miner.js";
import { Threat } from "../lib/Threat.js";
import { behaviorClass } from "../behaviors/index.js";
import { Debug } from "../lib/Debug.js";

// ============================================================================
//  RemoteLogisticsOverlord — hauls ALL mined remote sources home (#18 C2, #102, #204).
//
//  ONE shared fleet (mirroring the single home LogisticsOverlord), sized with the
//  SAME freight-turnover model (#84) summed over every source we're actually mining:
//    N = ceil( 2·Σ(r·d)·margin / (C·v) )
//  r = a remote miner's output, d = that source's one-way haul (static map), C =
//  hauler capacity. Demand is summed only over sources with a LIVE miner in an
//  economy-safe room — so the fleet tracks real production (it grows as miners come
//  online, not ahead of them) and ignores under-defended rooms (Threat.isHotForEconomy,
//  #150 — a guard-held room keeps its haulers). Sustaining this haul of
//  already-committed production is NOT expansion (it collects a return on a remote we
//  already paid for), so it is NOT expansionReady-gated (#131): expansionReady is the
//  "start a NEW remote" trigger and self-throttles to false when the spawn is busy —
//  exactly when active miners need haulers most. Demand follows the active miners; only
//  the recovering crisis floor zeroes it.
//
//  DISPATCH — the command pattern (#204). The overlord OWNS which source each hauler
//  services. (Previously a fat role self-picked: every hauler computed the same fullest
//  container and converged on it — a swarm — while the others overflowed.) Each tick it
//  now stamps a BALANCED target onto every free hauler; the thin RemoteHauler role + remoteHaul
//  behavior only EXECUTE it. Balancing is rate-matched tonne-km logistics: a source's
//  draw = energy on the ground/in-container NOW + the miner's accrual over the haul
//  (r·d) − capacity already inbound (committed haulers count as a claim). Greedy +
//  per-assignment claim-update spreads the fleet so the Nth hauler sees a container
//  already being drained and picks the next — convergence broken, delivery matched to
//  production ("по мере выработки"). See assignTargets().
// ============================================================================
const HAULER_SPEED = 1; // tiles/tick on roads/plains for a 1:1 CARRY:MOVE body
const FREIGHT_MARGIN = 1.3; // same headroom as the home freight model (#84)

export class RemoteLogisticsOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // after the home economy
  }

  get role() {
    return "remoteHauler";
  }

  desiredCount() {
    if (this.colony.health.recovering) return 0; // crisis floor only — sustaining active production isn't expansion (#131)
    const carry = Hauler.capacityAt(this.colony.room.energyCapacityAvailable);
    if (!carry) return 0;
    const rate = Miner.harvestRateAt(this.colony.room.energyCapacityAvailable); // energy/tick one remote miner produces

    const mined = this.minedSources();
    const demand = this.colony.remoteSources()
      .filter((s) => isFinite(s.dist) && !Threat.isHotForEconomy(s.room) && mined.has(this.sourceKey(s)))
      .reduce((sum, s) => sum + rate * s.dist, 0); // Σ r·d (tonne-tiles/tick)
    if (demand === 0) return 0;
    return Math.max(1, Math.ceil((2 * demand * FREIGHT_MARGIN) / (carry * HAULER_SPEED)));
  }

  // The body is the model's: read it off the unit's default behavior (the remoteHaul
  // node owns the CARRY/MOVE recipe), sized to the colony's spawn budget.
  bodyFor(energyBudget) {
    return behaviorClass(RemoteHauler.behaviors.default).bodyFor(energyBudget);
  }

  // Stamp the behavior set at birth so the BehaviorMachine drives the thin role.
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (req) req.memory.behaviors = RemoteHauler.behaviors;
    return req;
  }

  // Balanced dispatch (#204), then drive the creeps. Runs BEFORE super.run() so the
  // behavior reads a fresh target the same tick.
  run() {
    this.assignTargets();
    super.run();
  }

  runCreep(creep) {
    RemoteHauler.run(creep, this.colony);
  }

  // Assign each FREE hauler a balanced remote source, rate-matched and claim-aware so the
  // fleet spreads across containers instead of swarming the fullest (#204).
  assignTargets() {
    const haulers = this.assignedCreeps.filter((c) => !c.spawning);
    if (!haulers.length) return;

    const rate = Miner.harvestRateAt(this.colony.room.energyCapacityAvailable);
    const mined = this.minedSources();

    // Dispatch candidates + their per-tick supply, in one pass. A source qualifies if it's economy-safe
    // (#150) AND has energy worth a trip: either it's PRODUCING (a live miner arrived → its bank accrues
    // at r·d) OR it still holds energy NOW (pendingAt > 0 — a source whose miner just died still has a
    // banked container/overflow worth one last haul). An unmined, EMPTY source is skipped: dispatching
    // there strands a hauler where no energy will ever appear, and with claim-aware draw a draw-0 empty
    // source can even outrank an over-claimed producing one (#205). Supply = energy now + accrual (only
    // while producing). Computed once so the free-hauler loop subtracts the moving `claimed` term
    // instead of rescanning the room per hauler.
    const supply = {};
    const sources = [];
    for (const s of this.colony.remoteSources()) {
      if (Threat.isHotForEconomy(s.room)) continue;
      const k = this.sourceKey(s);
      const producing = mined.has(k);
      const pending = this.pendingAt(s);
      if (!producing && pending <= 0) continue;
      supply[k] = pending + (producing ? rate * s.dist : 0);
      sources.push(s);
    }
    const candidates = new Set(sources.map((s) => this.sourceKey(s)));

    // Free any hauler whose target is no longer a candidate — its room turned economy-unsafe (#150) or
    // its source stopped producing AND ran dry. The overlord owns the reassign decision (a carrying
    // hauler then delivers its partial load, #86; an empty one is reassigned below). A hauler gathering
    // at a still-producing (or still-stocked) source keeps its target — no thrash.
    for (const c of haulers) {
      const t = c.memory.haulTarget;
      if (t && !candidates.has(this.sourceKey(t))) {
        // Seed debug event (#215): target REVOKED — its room went economy-unsafe or its
        // source ran dry. No-op unless this creep/role is debug-enabled.
        Debug.for(c.memory.role, c.name).event(() => ({
          ev: "untarget", from: t.room, room: c.pos.roomName, x: c.pos.x, y: c.pos.y,
        }));
        c.memory.haulTarget = null;
      }
    }
    if (!sources.length) return;

    // Capacity already inbound to each source — a committed hauler keeps its assignment for the whole
    // load trip (#86 anti-oscillation), so it counts as a claim against its target's draw. Only count
    // GATHERING haulers (memory.working false): one delivering home no longer drains its source, so
    // claiming for it would falsely under-rate that source. This is what makes the greedy below
    // fleet-aware (without it every hauler scores identically → swarm).
    const claimed = {};
    for (const c of haulers) {
      const t = c.memory.haulTarget;
      if (t && !c.memory.working) {
        const k = this.sourceKey(t);
        claimed[k] = (claimed[k] || 0) + c.store.getFreeCapacity(RESOURCE_ENERGY);
      }
    }

    // Assign each FREE hauler (empty + unassigned — a carrying one with no target delivers, never chases
    // a fresh pickup, #86) to the source it will find the most energy at on arrival:
    //   draw(s) = supply(s) − capacity inbound
    // Greedy fullest-first with a per-assignment claim update spreads the fleet (the Nth hauler sees a
    // container already being drained → picks the next); source value tie-breaks between equal draws.
    const free = haulers.filter((c) => !c.memory.haulTarget && c.store[RESOURCE_ENERGY] === 0);
    for (const c of free) {
      let best = null;
      let bestDraw = -Infinity;
      let bestValue = -Infinity;
      for (const s of sources) {
        const k = this.sourceKey(s);
        const draw = supply[k] - (claimed[k] || 0);
        if (draw > bestDraw || (draw === bestDraw && s.value > bestValue)) {
          bestDraw = draw;
          bestValue = s.value;
          best = s;
        }
      }
      if (!best) break;
      c.memory.haulTarget = { room: best.room, x: best.x, y: best.y };
      claimed[this.sourceKey(best)] = (claimed[this.sourceKey(best)] || 0) + c.store.getFreeCapacity(RESOURCE_ENERGY);
      // Seed debug event (#215): target ASSIGNED — which source this free hauler was sent
      // to and the draw that won it. No-op unless this creep/role is debug-enabled.
      const draw = Math.round(bestDraw);
      Debug.for(c.memory.role, c.name).event(() => ({
        ev: "target", to: best.room, draw, room: c.pos.roomName, x: c.pos.x, y: c.pos.y,
      }));
    }
  }

  // Energy waiting at a source we can see: the miner's dropped pile (within range 2) plus the source
  // container's store once built (#114). No vision → 0 (the value tie-break carries the choice). Mirrors
  // the old role-side pickHaulTarget pending, now owned by the controller.
  pendingAt(s) {
    const room = Game.rooms[s.room];
    if (!room) return 0;
    let pending = new RoomPosition(s.x, s.y, s.room)
      .findInRange(FIND_DROPPED_RESOURCES, 2, { filter: (r) => r.resourceType === RESOURCE_ENERGY })
      .reduce((sum, r) => sum + r.amount, 0);
    const cinfo = Memory.colonyData?.[this.colony.name]?.remoteContainers?.[this.sourceKey(s)];
    if (cinfo && cinfo.hits != null) {
      const container = new RoomPosition(cinfo.x, cinfo.y, s.room)
        .lookFor(LOOK_STRUCTURES)
        .find((st) => st.structureType === STRUCTURE_CONTAINER);
      if (container) pending += container.store[RESOURCE_ENERGY];
    }
    return pending;
  }

  // Sources whose miner has actually ARRIVED at its source room (not spawning, crossing, or retreating)
  // — the producing set. Both the freight sizing and the dispatch accrual gate on it, so neither acts on
  // a miner that isn't dropping energy yet.
  minedSources() {
    return new Set(
      this.colony.creepsWithRole("remoteMiner")
        .filter((c) => !c.spawning && c.memory.remoteSource && c.room.name === c.memory.remoteSource.room)
        .map((c) => `${c.memory.remoteSource.room}:${c.memory.remoteSource.x}:${c.memory.remoteSource.y}`)
    );
  }

  sourceKey(s) {
    return `${s.room}:${s.x}:${s.y}`;
  }
}
