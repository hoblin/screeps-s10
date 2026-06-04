import { Miner } from "./Miner.js";
import { bodyFromTemplate } from "../lib/BodyGenerator.js";

// ============================================================================
//  LinkedMiner — a static Miner that feeds an adjacent source link (#17).
//
//  Identical to the base Miner (same post, same 5-WORK full-source tap) but with ONE
//  CARRY added: each tick it `transfer`s its harvest one tile into the source link
//  beside its container, which teleports that energy straight to the controller link
//  the upgraders drain. That source's whole haul leg disappears — no hauler ferries
//  it home. The CARRY is purely extra ferrying capacity; WORK is unchanged, so the
//  source still taps at 100% (the miner offloads 10/tick, so the CARRY never fills).
//
//  Backpressure is graceful: if the link is full (upgraders not draining), the CARRY
//  fills and the next harvest's overflow auto-drops into the container underfoot, so a
//  hauler takes it home and the source keeps tapping — no waste, no throttle beyond
//  the universal "everything downstream is full" case the base miner also hits.
//
//  MiningOverlord spawns this (instead of Miner) for the source whose link is built;
//  it's dispatched by the overlord, so the role string stays "miner" (movementPriority
//  and telemetry unchanged — a LinkedMiner IS a miner, just one that feeds a link).
// ============================================================================
export class LinkedMiner extends Miner {
  // Base static-miner body + ONE CARRY to ferry the harvest into the link. Same
  // 5-WORK / 2-MOVE core (full tap, mixed-terrain travel); the CARRY rides on top, so
  // at the RCL5+ budget where links exist the WORK count is never traded away.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, MOVE, MOVE, CARRY], { extra: [WORK], max: 4, energy: energyBudget });
  }

  // After harvesting, push the carried energy one tile into the adjacent source link.
  // A full link just leaves the energy in the CARRY → the next harvest overflows into
  // the container underfoot (handled by the base hook's drop semantics + the hauler),
  // so the source never throttles. Then keep the container repaired (inherited).
  static afterHarvest(creep, colony) {
    if (creep.store[RESOURCE_ENERGY] > 0) {
      const source = Game.getObjectById(creep.memory.sourceId);
      const link = source && colony.sourceLink(source.id);
      if (link && creep.pos.isNearTo(link)) creep.transfer(link, RESOURCE_ENERGY);
    }
    super.afterHarvest(creep, colony);
  }
}
