import { Overlord } from "./Overlord.js";
import { RemoteMiner } from "../roles/RemoteMiner.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  RemoteMiningOverlord — mines ONE remote source (#18 C2, generalised in #102).
//
//  One instance per reachable remote source (Colony builds them from
//  remoteSources()), exactly mirroring the home per-source MiningOverlord — remote
//  mining is "just more mining overlords", not a structural change. Each instance:
//   • is keyed by its source's room+tile (the offline map has no Game IDs), so its
//     creep binds to it and no two instances fight over miners;
//   • requests ONE RemoteMiner, but only while the home economy has spare capacity
//     (health.expansionReady, #89) AND its room is not currently contested
//     (Threat.isHot, #105). expansionReady self-throttles the whole set: each miner
//     spawned drops spawn-idle, so the latch releases and the rest wait their turn,
//     best-value source first (remoteSources() is value-ranked).
//
//  v1 drop-mines (no remote container) — the miner piles energy on the ground for
//  the shared remote hauler fleet. The source tile is stamped at spawn so the miner
//  binds to THIS source (it can't live-read "the" source once there are many).
// ============================================================================
export class RemoteMiningOverlord extends Overlord {
  constructor(colony, source) {
    // Key on room+tile: stable across ticks/resets and unique per source, so the
    // identifier ("remoteMiner:E16S7:3:42") survives the per-tick Colony rebuild.
    super(colony, { priority: 5, instanceId: `${source.room}:${source.x}:${source.y}` });
    this.src = source; // { room, dir, x, y, dist, value, controller }
  }

  get role() {
    return "remoteMiner";
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    if (Threat.isHot(this.src.room)) return 0; // contested — stop spawning for it
    return 1;
  }

  bodyFor(energyBudget) {
    return RemoteMiner.bodyFor(energyBudget);
  }

  // Stamp WHICH source this miner serves (room+tile) on top of the base ownership
  // tags. With many sources the role can't read "the" target live — it binds to
  // this one for life; threat re-routing is handled by desiredCount (no new miner
  // for a hot room) and the role's own retreat (it reads the shared intel #105).
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (req) {
      req.memory.remoteSource = {
        room: this.src.room, x: this.src.x, y: this.src.y, dist: this.src.dist,
      };
    }
    return req;
  }

  runCreep(creep) {
    RemoteMiner.run(creep, this.colony);
  }
}
