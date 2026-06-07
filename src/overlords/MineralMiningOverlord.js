import { Overlord } from "./Overlord.js";
import { MineralMiner } from "../roles/MineralMiner.js";
import { MineralHauler } from "../roles/MineralHauler.js";
import { MiningSite } from "../lib/MiningSite.js";
import { stageAtLeast } from "../lib/Stages.js";
import { log } from "../lib/Logger.js";

// ============================================================================
//  MineralMiningOverlord — the room's mineral economy (#19, Stage 4 Industry).
//
//  A SINGLETON (one mineral per room, unlike per-source MiningOverlord) owning the whole mineral domain
//  across two roles (like ClaimOverlord owns claimer+pioneer): it places the Extractor, keeps a container
//  alive beside the mineral (the shared MiningSite, the 2nd tenant of that lifecycle), and drives a static
//  MineralMiner (drop-mines into the container) + a MineralHauler (container → storage).
//
//  SPARE-CAPACITY work, lowest priority (5, with the remote economy). With no Terminal/Labs yet the
//  mineral just banks in storage — useful prep, not urgent — so it must never steal spawn time from the
//  core economy, remotes, expansion, or the score fleet:
//   • The Extractor STRUCTURE is placed the moment RCL 6 unlocks it (prepare ahead — cheap, workers
//     build it in their normal queue).
//   • The MINER (a new spawn-cost specialist) gates on `expansionReady` — spare spawn-idle — exactly as
//     remote mining does (cost-gating: gate a capability on the resource it consumes).
//   • The HAULER sustains committed production (not expansion), so it gates on `!recovering` only, like
//     RemoteLogisticsOverlord, and lives while there's a miner OR leftover mineral to drain.
//  A depleted mineral (mineralAmount 0) drops the miner count to 0 — no churn; it regenerates and the
//  miner returns. The hauler lingers to drain the container's leftovers, then stops.
// ============================================================================
export class MineralMiningOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // lowest tier — spare-capacity, never preempts the economy
    this.mineral = colony.mineral;
    // 2nd tenant of the shared container-mining-site lifecycle (#19); keyed by the mineral id.
    this.site = this.mineral ? new MiningSite(colony, this.mineral, "mineral") : null;
  }

  get role() {
    return "mineralMiner";
  }

  get roles() {
    return ["mineralMiner", "mineralHauler"]; // owns the whole mineral domain
  }

  // Is the Extractor built on the mineral? Required before a miner can harvest it.
  extractorBuilt() {
    return (
      !!this.mineral &&
      this.mineral.pos
        .lookFor(LOOK_STRUCTURES)
        .some((s) => s.structureType === STRUCTURE_EXTRACTOR)
    );
  }

  // Miner: one static miner, but only when the economy can spare the body AND there's mineral to dig.
  // expansionReady (spare spawn-idle) is the right gate for a new specialist's spawn cost.
  minerCount() {
    if (!stageAtLeast(this.colony, "4:Industry")) return 0;
    if (this.colony.health.recovering) return 0;
    if (!this.colony.health.expansionReady) return 0;
    if (!this.extractorBuilt()) return 0; // can't harvest a mineral without an Extractor
    // Wait for the container too: a mineral miner is CARRY-less and unlike dropped ENERGY (which workers
    // /haulers scoop off the ground), dropped MINERAL has no scavenger — the hauler only withdraws from
    // the container. So no miner until its container exists, else its yield decays on the ground.
    if (!this.colony.mineralContainer()) return 0;
    if (!this.mineral || this.mineral.mineralAmount === 0) return 0; // depleted — wait for regen
    return 1;
  }

  // Hauler: drains the container to storage. Worth a body while a miner is producing OR the container
  // still holds mineral to clear (so leftovers drain after a mineral depletes and the miner stops).
  haulerCount() {
    if (this.colony.health.recovering) return 0;
    if (this.colony.creepsWithRole("mineralMiner").length > 0) return 1;
    const container = this.colony.mineralContainer();
    const leftover =
      container &&
      Object.keys(container.store).some((r) => r !== RESOURCE_ENERGY && container.store[r] > 0);
    return leftover ? 1 : 0;
  }

  // Emit the right body for the active role — miner first (the hauler is pointless without production),
  // then hauler. Built manually (per-role body + stamped target) like ClaimOverlord/ScoutOverlord.
  generateSpawnRequest() {
    if (!this.mineral) return null;
    const budget = this.colony.spawnEnergyBudget();

    if (this.colony.creepsWithRole("mineralMiner").length < this.minerCount()) {
      const pos = this.site && this.site.position;
      return {
        priority: this.priority,
        role: "mineralMiner",
        body: MineralMiner.bodyFor(budget),
        memory: {
          role: "mineralMiner",
          colony: this.colony.name,
          overlord: this.identifier,
          mineralId: this.mineral.id,
          miningPos: pos ? { x: pos.x, y: pos.y, roomName: pos.roomName } : null,
        },
      };
    }
    if (this.colony.creepsWithRole("mineralHauler").length < this.haulerCount()) {
      return {
        priority: this.priority,
        role: "mineralHauler",
        body: MineralHauler.bodyFor(budget),
        memory: {
          role: "mineralHauler",
          colony: this.colony.name,
          overlord: this.identifier,
        },
      };
    }
    return null;
  }

  // Place the Extractor on the mineral the moment RCL 6 unlocks it (prepare ahead). One structure, fixed
  // tile (the mineral) — no geometry, so it places directly rather than via a planner. Mirrors the
  // stage+RCL-cap gate of CommandCenter.planStorage; tolerated non-OKs (not-yet-RCL, already-there) stay quiet.
  ensureExtractor() {
    if (!stageAtLeast(this.colony, "4:Industry")) return;
    if (!this.mineral) return;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_EXTRACTOR] || {})[this.colony.controller.level] || 0;
    if (cap === 0) return; // not unlocked yet (RCL < 6)
    const pos = this.mineral.pos;
    if (pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_EXTRACTOR)) return;
    if (pos.lookFor(LOOK_CONSTRUCTION_SITES).some((s) => s.structureType === STRUCTURE_EXTRACTOR)) return;
    const res = this.room.createConstructionSite(pos, STRUCTURE_EXTRACTOR);
    if (res !== OK && res !== ERR_RCL_NOT_ENOUGH && res !== ERR_INVALID_TARGET) {
      log.warn(`[${this.colony.name}] extractor site failed at ${pos}: ${res}`);
    }
  }

  // Keep the extractor + container alive, re-stamp the mining tile onto any miner missing it, then drive.
  run() {
    this.ensureExtractor();
    if (this.site) this.site.ensureContainer();
    this.stampMiningPosition();
    super.run();
  }

  // Ensure every mineral miner knows its parking tile (new ones get it at spawn; this fills adopted ones).
  stampMiningPosition() {
    const pos = this.site && this.site.position;
    if (!pos) return;
    for (const creep of this.colony.creepsWithRole("mineralMiner")) {
      if (!creep.memory.miningPos) {
        creep.memory.miningPos = { x: pos.x, y: pos.y, roomName: pos.roomName };
      }
    }
  }

  runCreep(creep) {
    if (creep.memory.role === "mineralHauler") MineralHauler.run(creep, this.colony);
    else MineralMiner.run(creep, this.colony);
  }
}
