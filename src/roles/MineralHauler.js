import { Role } from "./Role.js";
import { Hauler } from "./Hauler.js";

// ============================================================================
//  MineralHauler — drains the mineral container to storage (#19, Stage 4).
//
//  The mineral miner is CARRY-less and drops its yield into the container beneath it; this creep moves
//  that mineral to storage (the only sink until a Terminal lands, #20). Low-frequency work — the mineral
//  trickles in slowly — so one CARRY/MOVE hauler is plenty, gated low-priority on the owning overlord.
//
//  Can't reuse Hauler.collect/deliver: those hardcode RESOURCE_ENERGY at every withdraw/transfer. Can't
//  reuse Role.updateWorkingState either — its empty-check tests store[RESOURCE_ENERGY] specifically, so
//  a creep full of mineral would read "empty" and never deliver. So this carries a tiny resource-agnostic
//  load toggle (used vs free capacity) and moves whatever mineral it holds.
// ============================================================================
export class MineralHauler extends Role {
  static movementPriority = 3;

  // Pure transport, like the energy hauler — CARRY + MOVE scaled to the budget.
  static bodyFor(energyBudget) {
    return Hauler.bodyFor(energyBudget);
  }

  static run(creep, colony) {
    const m = creep.memory;
    if (m.working && creep.store.getUsedCapacity() === 0) m.working = false;
    if (!m.working && creep.store.getFreeCapacity() === 0) m.working = true;
    if (m.working) this.deliver(creep, colony);
    else this.collect(creep, colony);
  }

  // Withdraw the mineral from the mineral container. If there's nothing to top up but we already carry
  // a partial load, deliver it rather than idle forever (the miner may have stopped on a depleted
  // mineral, so the container won't refill soon). Otherwise idle near the container, ready to drain it.
  static collect(creep, colony) {
    const container = colony.mineralContainer();
    const resource =
      container &&
      Object.keys(container.store).find((r) => r !== RESOURCE_ENERGY && container.store[r] > 0);
    if (!resource) {
      if (creep.store.getUsedCapacity() > 0) {
        creep.memory.working = true; // flush the partial load
        return this.deliver(creep, colony);
      }
      this.note(creep, "mhaul:idle");
      const anchor = container || colony.mineral;
      if (anchor && !creep.pos.inRangeTo(anchor, 2)) creep.travelTo(anchor, { range: 2 });
      return;
    }
    this.note(creep, "mhaul:withdraw");
    if (creep.withdraw(container, resource) === ERR_NOT_IN_RANGE) creep.travelTo(container);
  }

  // Deposit the carried mineral into storage (the only sink until a Terminal exists, #20).
  static deliver(creep, colony) {
    const storage = colony.room.storage;
    if (!storage) return; // no storage — hold the load (storage exists by Stage 3, well before Stage 4)
    const resource = Object.keys(creep.store).find((r) => creep.store[r] > 0);
    if (!resource) return;
    this.note(creep, "mhaul:store");
    if (creep.transfer(storage, resource) === ERR_NOT_IN_RANGE) creep.travelTo(storage);
  }
}
