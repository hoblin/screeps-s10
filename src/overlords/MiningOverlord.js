import { Overlord } from "./Overlord.js";
import { Miner } from "../roles/Miner.js";
import { LinkedMiner } from "../roles/LinkedMiner.js";
import { MiningSite } from "../lib/MiningSite.js";
import { stageAtLeast } from "../lib/Stages.js";

// ============================================================================
//  MiningOverlord — owns the static mining of ONE source (Overmind-style:
//  one overlord instance per source). The Colony creates one of these for each
//  source in the room, so remote/outpost mining later is just "more instances".
//
//  Responsibilities:
//   1. Decide the single tile a miner should stand on (the "mining position"),
//      which is also where the source's container belongs.
//   2. Keep a container construction site / container alive on that tile.
//   3. Spawn and drive exactly one static Miner for this source.
//
//  Each instance is identified by `miner:<full-sourceId>` so its miner is never
//  confused with another source's miner, even though they share the role
//  "miner".
// ============================================================================
export class MiningOverlord extends Overlord {
  /**
   * @param {Colony} colony
   * @param {Source} source - the specific source this overlord mines
   */
  constructor(colony, source) {
    // Mining is top priority: no energy income means no colony at all.
    // Use the FULL source id as the instance identifier. It's only a memory
    // string, so length doesn't matter, and a truncated suffix could collide
    // between two sources that share their last few chars.
    super(colony, { priority: 1, instanceId: source.id });
    this.source = source;
    // The container-site lifecycle (mining tile + container keep-alive) is the shared MiningSite,
    // also used by mineral mining (#19). Source-only state (the JIT-relief `dist`) is layered onto
    // the same cache object below — MiningSite only writes the position fields, so they coexist.
    this.site = new MiningSite(colony, source, "source");
  }

  get role() {
    return "miner";
  }

  // One static miner per source is enough to fully drain it (5×WORK = 10/tick),
  // but a CARRY-less miner only earns its keep once a container exists to catch
  // its drops and a hauler/worker can move that energy. So gate it on Stage 2:
  // during Bootstrap (Stage 1) the colony lives on self-sufficient generic
  // WorkOverlord workers (WORK+CARRY+MOVE) — mirrors how Logistics/Upgrade wait
  // on "2b:Hauling". Stage 2 enters at RCL≥2 or when a container exists, exactly
  // the moment static mining starts paying off.
  desiredCount() {
    if (!stageAtLeast(this.colony, "2:StaticMining")) return 0;
    // Just-in-time relief (#168): once the on-station miner is within its spawn+travel lead of
    // dying, declare the source needs TWO — the base spawn gate then orders the relief NOW so it
    // arrives as the incumbent expires (near-zero unmined gap). The relief is already counted by
    // assignedCreeps (spawning ttl=undefined, then traveling ttl≈full), so exactly ONE is ordered;
    // once the incumbent dies the lead no longer matches and this drops back to 1. The dying miner
    // keeps mining until real death (run() ignores TTL). Killed early → no incumbent → reads 1,
    // count 0 → immediate reactive replacement, exactly as before.
    return this.incumbentDying() ? 2 : 1;
  }

  // True when an on-station miner is within `replacementLead` ticks of dying — the trigger to
  // pre-order its relief. Spawning creeps (ttl undefined) and a fresh traveling relief (ttl ≈
  // CREEP_LIFE_TIME) are far above the lead, so only the genuine incumbent fires this.
  incumbentDying() {
    const lead = this.replacementLead();
    if (!lead) return false; // geometry unknown yet → fall back to reactive replacement
    return this.assignedCreeps.some((c) => c.ticksToLive !== undefined && c.ticksToLive < lead);
  }

  // Ticks between ordering a relief and it standing on the post — the shared JIT primitive (#168/#210),
  // fed this source's spawn→post distance and the miner body. (a WORK-heavy miner is sub-1-tile/tick.)
  replacementLead() {
    const dist = this.sourceDistance();
    if (dist == null) return 0;
    return Miner.replacementLead(this.bodyFor(this.colony.spawnEnergyBudget()), dist);
  }

  // Cached spawn→mining-tile path distance (static geometry — computed ONCE then reused; a
  // per-tick pathLength would be wasted CPU). Stored alongside the mining position. Returns null
  // until the position is established, or if the tile is unreachable.
  sourceDistance() {
    const cache = this.miningPositionCache;
    if (!cache) return null;
    const spawns = this.colony.spawns;
    if (!spawns.length) return null;
    // Size the lead to the WORST-CASE spawn — the Hatchery births the relief from whichever spawn
    // is free, not necessarily spawns[0], so taking the farthest keeps the relief from ever
    // arriving late. Static geometry, cached; recomputed only when the mining tile resets or a new
    // spawn appears (RCL7/8 add spawns) — never per tick.
    if (cache.dist == null || cache.distSpawns !== spawns.length) {
      const tile = new RoomPosition(cache.x, cache.y, cache.roomName);
      let far = -1; // -1 = unreachable from every spawn (JSON-safe sentinel; Infinity → null)
      for (const s of spawns) {
        const d = this.colony.pathLength(s.pos, tile); // steps to range 1 of the tile
        if (d !== Infinity) far = Math.max(far, d + 1); // +1: the miner stands ON the tile
      }
      cache.dist = far;
      cache.distSpawns = spawns.length;
    }
    return cache.dist >= 0 ? cache.dist : null;
  }

  // The role class to field for this source: LinkedMiner (a Miner + CARRY that feeds
  // an adjacent source link) once that link is built, else the plain drop-mining
  // Miner (#17). The body + behaviour both come from this one choice.
  minerClass() {
    return this.colony.sourceLink(this.source.id) ? LinkedMiner : Miner;
  }

  // The static-miner body lives on the role (its own nature, with the WORK/MOVE
  // rationale); the overlord just asks the right class for it.
  bodyFor(energyBudget) {
    return this.minerClass().bodyFor(energyBudget);
  }

  // --------------------------------------------------------------------------
  //  Mining position: the tile a miner parks on and the container sits under —
  //  the walkable source-adjacent tile nearest (by path) to a spawn. Delegated to
  //  the shared MiningSite (compute-once + cache). The source-only `dist` for JIT
  //  relief is layered onto the same cache object by sourceDistance() below.
  // --------------------------------------------------------------------------
  get miningPosition() {
    return this.site.position;
  }

  // Read-only view of the cache object (the {x,y,roomName} MiningSite wrote, plus the dist/distSpawns
  // sourceDistance mutates onto it in place). MiningSite owns the position WRITE; this getter is just
  // how sourceDistance reaches the shared object to append its source-only JIT fields.
  get miningPositionCache() {
    return (Memory.colonyData?.[this.colony.name]?.miningPos || {})[this.source.id];
  }

  // --------------------------------------------------------------------------
  //  Container lifecycle: delegated to the shared MiningSite — keep a container
  //  (or its site) alive on the mining tile. Workers build it; the miner drops
  //  energy into the finished container.
  // --------------------------------------------------------------------------
  ensureContainerSite() {
    this.site.ensureContainer();
  }

  // --------------------------------------------------------------------------
  //  Spawn request: stamp the source + mining position onto the new miner so it
  //  knows where to go without recomputing anything.
  // --------------------------------------------------------------------------
  generateSpawnRequest() {
    const request = super.generateSpawnRequest();
    if (!request) return null;

    const position = this.miningPosition;
    request.memory.sourceId = this.source.id;
    request.memory.miningPos = position
      ? { x: position.x, y: position.y, roomName: position.roomName }
      : null;
    return request;
  }

  runCreep(creep) {
    this.minerClass().run(creep, this.colony);
  }

  // Called by Colony each tick. Keeps the container site alive even before any
  // miner exists, re-stamps the mining position onto any creep that lacks one
  // (e.g. creeps adopted via legacy migration), then drives the creeps.
  run() {
    this.ensureContainerSite();
    this.stampMiningPositionOnAssignedCreeps();
    super.run();
  }

  // Make sure every creep we own knows its mining position. New miners get it at
  // spawn time, but adopted (migrated) creeps may not — fill it in here so they
  // can park properly instead of relying on the source-direct fallback forever.
  stampMiningPositionOnAssignedCreeps() {
    const position = this.miningPosition;
    if (!position) return;
    for (const creep of this.assignedCreeps) {
      if (!creep.memory.miningPos) {
        creep.memory.miningPos = {
          x: position.x,
          y: position.y,
          roomName: position.roomName,
        };
      }
    }
  }
}
