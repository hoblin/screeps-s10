import { HiveCluster } from "./HiveCluster.js";
import { StoragePlanner } from "../lib/StoragePlanner.js";
import { LinkPlanner } from "../lib/LinkPlanner.js";
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
  //  Storage placement (relocated from the Hatchery; StoragePlanner unchanged).
  //  At RCL4 (Stage 3) place the single central Storage — the mid-game buffer.
  // --------------------------------------------------------------------------
  planStorage() {
    if (!stageAtLeast(this.colony, "3:Storage&Links")) return;
    const rcl = this.colony.controller.level;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_STORAGE] || {})[rcl] || 0;
    if (cap === 0) return; // storage not unlocked yet (RCL < 4)
    if (this.room.storage) return; // already built — nothing to place
    const anchor = this.colony.spawns[0];
    if (!anchor) return;
    const position = this.storagePosition(anchor);
    if (position) StoragePlanner.ensureSite(this.room, position);
  }

  // The planned storage tile, computed once via StoragePlanner and cached in colony
  // memory. Null until a central buildable tile is found.
  storagePosition(anchor) {
    const cached = this.storagePositionCache;
    if (cached) return new RoomPosition(cached.x, cached.y, cached.roomName);
    const position = StoragePlanner.planPosition(this.room, anchor.pos, this.colony.controller.pos);
    if (position) {
      this.storagePositionCache = { x: position.x, y: position.y, roomName: position.roomName };
    }
    return position;
  }

  get storagePositionCache() {
    return Memory.colonyData?.[this.colony.name]?.storagePosition;
  }

  set storagePositionCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].storagePosition = value;
  }

  // --------------------------------------------------------------------------
  //  Link placement. Two-axis gate: stage + RCL cap (unlocked) AND
  //  energyRich && !recovering (can we afford the 5000-energy investment now).
  // --------------------------------------------------------------------------
  planLinks() {
    if (!stageAtLeast(this.colony, "3:Storage&Links")) return;
    const rcl = this.colony.controller.level;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_LINK] || {})[rcl] || 0;
    if (cap === 0) return; // links not unlocked yet (RCL < 5)
    const health = this.colony.health;
    if (!health.energyRich || health.recovering) return; // can't afford the investment now
    const layout = this.linkLayout();
    if (layout.length) LinkPlanner.ensureSites(this.room, layout, cap);
  }

  // Priority-ordered desired link tiles: the controller link (receiver) + a source
  // link (sender) on the source FARTHEST from the controller — the RCL5 cap-2 pair,
  // killing the longest haul leg. Both anchors must exist (controller dropoff known,
  // the linked source's container tile cached) — returns [] until then. Each tile is
  // chosen adjacent to its hub, facing its partner (shortest link range = shortest
  // cooldown). Cached: deterministic from the anchors.
  linkLayout() {
    const cached = this.linkLayoutCache;
    if (cached) {
      return cached.map((e) => ({ role: e.role, sourceId: e.sourceId, pos: new RoomPosition(e.x, e.y, e.roomName) }));
    }
    const ctrlPos = this.colony.controllerDropoffPos();
    const sources = this.colony.sources;
    if (!ctrlPos || !sources.length) return [];
    // The source whose haul to the controller is longest → most haul saved by linking.
    const ctrl = this.colony.controller;
    const linked = sources.reduce((far, s) =>
      s.pos.getRangeTo(ctrl) > far.pos.getRangeTo(ctrl) ? s : far
    );
    const srcContainer = this.colony.sourceContainerPos(linked);
    if (!srcContainer) return []; // mining position not cached yet
    const ctrlTile = LinkPlanner.linkTile(this.room, ctrlPos, srcContainer);
    const srcTile = LinkPlanner.linkTile(this.room, srcContainer, ctrlPos);
    // Commit only the FULL RCL5 pair. A lone link is useless — a 5000-energy sink with
    // no partner to transfer to — and a lone controller link wouldn't be discoverable
    // via Colony.controllerLink() until cached. Wait until BOTH tiles resolve, so
    // planLinks never queues a single unpaired link (#133 review).
    if (!ctrlTile || !srcTile) return [];
    const layout = [
      { role: "controller", pos: ctrlTile },
      { role: "source", sourceId: linked.id, pos: srcTile },
    ];
    this.linkLayoutCache = layout.map((e) => ({
      role: e.role, sourceId: e.sourceId, x: e.pos.x, y: e.pos.y, roomName: e.pos.roomName,
    }));
    return layout;
  }

  get linkLayoutCache() {
    return Memory.colonyData?.[this.colony.name]?.linkPositions;
  }

  set linkLayoutCache(value) {
    Memory.colonyData ||= {};
    Memory.colonyData[this.colony.name] ||= {};
    Memory.colonyData[this.colony.name].linkPositions = value;
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
