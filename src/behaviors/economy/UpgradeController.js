import { Behavior } from "../Behavior.js";
import { Role } from "../../roles/Role.js";
import { Hauler } from "../../roles/Hauler.js";
import { Upgrade } from "./Upgrade.js";
import { bodyFromTemplate } from "../../lib/BodyGenerator.js";

// ============================================================================
//  UpgradeController (#251) — the dedicated upgrader's park-and-pump conduct, lifted out of the
//  procedural Upgrader role into the behaviour paradigm (mirrors Worker→Work, Pioneer→Pioneer).
//
//  A TWO-LEVEL loop, like Work, driven by the shared Hauler.runCycle gather↔work FSM:
//   • DELIVER (full) — pump the controller via the shared Upgrade atom (upgradeController at range 3,
//     travelTo only if out of range). This IS the pre-lift working-state conduct, unchanged.
//   • COLLECT (empty) — the controller-FEED ladder, so the upgrader never walks back to a source
//     container: controller LINK → controller CONTAINER → (container empty) park beside it / top up
//     from reachable spare energy rather than idle toward a downgrade → (no container yet) generic
//     gather. The dist-2 controller-container placement keeps both withdraw (range 1) and upgrade
//     (range 3) satisfied from one parking tile.
//
//  Count + controller-container planning stay on the UpgradeOverlord; this node only EXECUTES.
// ============================================================================
export class UpgradeController extends Behavior {
  // The upgrader body (the model owns it; UpgradeOverlord reads this off the default behaviour).
  // Scales to 15×WORK (the RCL8 controller saturation) so an upgrader uses the available spawn
  // capacity instead of stalling at 5 WORK (#248); pre-RCL8 a bigger upgrader drains the buffer
  // hoard into RCL faster. Budget caps it lower at low RCL (≈11 WORK at 2300).
  static bodyFor(energyBudget) {
    return bodyFromTemplate([WORK, CARRY, MOVE], { extra: [WORK, CARRY, MOVE], max: 14, energy: energyBudget });
  }

  // Drive the gather↔work cycle with THIS class as the conduct (collect/deliver below).
  static run(creep, colony) {
    Hauler.runCycle(creep, colony, this);
  }

  // ---- deliver (full): pump the controller — the shared Upgrade atom. Identical to the pre-lift
  //      working-state branch (upgradeController, travelTo on ERR_NOT_IN_RANGE).
  static deliver(creep, colony) {
    Upgrade.run(creep, colony);
  }

  // ---- collect (empty): the park-and-pump feed chain, preferring the controller's own feeders.
  static collect(creep, colony) {
    this.note(creep, "upgrade:gather");

    // Empty-state moves run at the gather priority so a parking upgrader never shoves an
    // actively-working creep (#58) — same rule as Role.gatherEnergy.
    const move = (target) => creep.travelTo(target, { priority: Role.gatherMovementPriority });

    // Controller link (#17): once the link network is live, energy teleports to the controller link
    // (beside the parking) — withdraw from it first, zero-haul. Null until RCL5/links, so this is
    // inert before then and falls through to the container.
    const controllerLink = colony.controllerLink();
    if (controllerLink && controllerLink.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(controllerLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        move(controllerLink);
      }
      return;
    }

    const controllerContainer = Hauler.controllerContainer(colony);
    if (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        move(controllerContainer);
      }
      return;
    }

    if (controllerContainer) {
      // Container exists but is empty. Prefer to wait beside it (parking next to it keeps us in
      // upgrade range, so a refill costs no walking). But if there's energy within a few tiles right
      // now, grab that instead of idling, so a slow/missing hauler can't stall the controller toward
      // downgrade. Source containers stay off-limits: that round trip is what parking avoids.
      if (!creep.pos.inRangeTo(controllerContainer, 1)) {
        move(controllerContainer);
      } else if (this.reachableSpareEnergy(creep, colony)) {
        Role.gatherEnergy(creep, colony);
      }
      return;
    }

    // No controller container yet (early game): self-serve generically.
    Role.gatherEnergy(creep, colony);
  }

  // Is there non-source energy close enough that topping up from it beats idling at an empty
  // controller container? Looks for dropped energy / tombstones / non-source containers near the
  // upgrader; deliberately ignores source containers (the long commute we're avoiding). Cheap range
  // scan, no pathfinding.
  static reachableSpareEnergy(creep, colony) {
    const SCAN = 5;
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, SCAN, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0,
    });
    if (dropped.length > 0) return true;

    const tombs = creep.pos.findInRange(FIND_TOMBSTONES, SCAN, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });
    if (tombs.length > 0) return true;

    const spareContainers = creep.pos.findInRange(FIND_STRUCTURES, SCAN, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > 0 &&
        !Hauler.isSourceContainer(s, colony),
    });
    return spareContainers.length > 0;
  }
}
