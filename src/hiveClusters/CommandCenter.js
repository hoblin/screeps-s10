import { HiveCluster } from "./HiveCluster.js";
import { RoomPlanner } from "../lib/RoomPlanner.js";
import { StructureRealizer } from "../lib/StructureRealizer.js";
import { stageAtLeast } from "../lib/Stages.js";

// A transmit link sends only once nearly full, so the flat 3% transfer loss always
// rides a near-full payload instead of dribbling (Overmind's `linksTransmitAt`).
const LINK_TRANSMIT_AT = LINK_CAPACITY - 100;
// …unless the receiver is below this fraction — then top it up early so upgraders
// never starve waiting for a full batch.
const RECEIVER_LOW_FRAC = 0.5;
// Don't pay the 3% loss to move a trickle.
const LINK_MIN_PAYLOAD = 100;

// ============================================================================
//  CommandCenter — the central-structure HiveCluster: Storage + the Link network
//  (#16/#17). Extracted now per "defer the abstraction to the 2nd tenant": storage
//  lived temporarily in the Hatchery until links gave central structures a second
//  tenant. Like DefenseOverlord with towers, it drives STRUCTURES, not creeps.
//
//  Link topology (RCL5, cap 2): a SOURCE link (sender, beside the farthest source's
//  container) teleports to a CONTROLLER link (receiver, beside the upgrader parking)
//  that upgraders drain — the LinkedMiner on that source `transfer`s its harvest one
//  tile into the source link (Overmind's canonical source→controller), so that
//  source's WHOLE haul leg disappears (no hauler needed for it). Both build +
//  operation are two-axis gated: the RCL structure cap (unlocked) AND
//  energyRich && !recovering (afford it) — a 5000-energy link sunk mid-deficit starves
//  the economy it speeds up.
//
//  We link the source FARTHEST from the controller (most haul killed); the near source
//  stays drop-mined + hauled. The single source→controller transfer here is the
//  concrete form — when more links arrive (RCL6+: more source links) extract
//  Overmind's `LinkNetwork` greedy matcher (logistics/LinkNetwork.ts), deferred until
//  that 2nd sender exists.
// ============================================================================
export class CommandCenter extends HiveCluster {
  run() {
    this.planStorage();
    this.planLinks();
    this.operateLinks();
  }

  // --------------------------------------------------------------------------
  //  Storage placement: realize the planned Storage tile at RCL4 (Stage 3) — the
  //  mid-game buffer. The unified RoomPlanner (#258) chose the tile at founding.
  // --------------------------------------------------------------------------
  planStorage() {
    if (!stageAtLeast(this.colony, "3:Storage&Links")) return;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_STORAGE] || {})[this.colony.controller.level] || 0;
    if (cap === 0) return; // storage not unlocked yet (RCL < 4)
    if (this.room.storage) return; // already built — nothing to place
    StructureRealizer.ensureSites(this.room, STRUCTURE_STORAGE, RoomPlanner.tilesFor(this.colony, STRUCTURE_STORAGE), cap);
  }

  // --------------------------------------------------------------------------
  //  Link placement: realize the planned link tiles up to the RCL cap. The plan
  //  (#258) lays the pairs out priority-first — controller link, then source links
  //  far→near, then the storage link — each hugging its container/hub facing its
  //  partner (shortest range = shortest cooldown). Two-axis gate: stage + RCL cap
  //  (unlocked) AND energyRich && !recovering (can we afford the 5000-energy sink now).
  //  The cap fills the RCL5 controller+source pair first, so a lone link is never queued.
  // --------------------------------------------------------------------------
  planLinks() {
    if (!stageAtLeast(this.colony, "3:Storage&Links")) return;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_LINK] || {})[this.colony.controller.level] || 0;
    if (cap === 0) return; // links not unlocked yet (RCL < 5)
    const health = this.colony.health;
    if (!health.energyRich || health.recovering) return; // can't afford the investment now
    StructureRealizer.ensureSites(this.room, STRUCTURE_LINK, RoomPlanner.tilesFor(this.colony, STRUCTURE_LINK), cap);
  }

  // --------------------------------------------------------------------------
  //  Link operation (no creeps): each LinkedMiner-fed source link pushes to the
  //  controller link the upgraders drain. Transmit a near-full batch (loss rides a
  //  full load), but top up early if the controller link is running low so upgraders
  //  never starve. Fire only off-cooldown, into a receiver with room.
  // --------------------------------------------------------------------------
  operateLinks() {
    const ctrlLink = this.colony.controllerLink();
    if (!ctrlLink) return;
    if (ctrlLink.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
    const receiverLow =
      ctrlLink.store[RESOURCE_ENERGY] < ctrlLink.store.getCapacity(RESOURCE_ENERGY) * RECEIVER_LOW_FRAC;

    for (const link of this.colony.sourceLinks()) {
      if (link.cooldown > 0) continue;
      const have = link.store[RESOURCE_ENERGY];
      if (have < LINK_MIN_PAYLOAD) continue;
      if (have < LINK_TRANSMIT_AT && !receiverLow) continue; // wait for a fuller batch
      if (link.transferEnergy(ctrlLink) === OK) return; // one transfer tops the receiver
    }
  }
}
