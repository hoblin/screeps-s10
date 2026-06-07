import { Behavior } from "../Behavior.js";

// ============================================================================
//  Upgrade (#239) — economy atom: pump the controller. The worker's idle fallback — last in
//  the work chain, so it runs only when there's nothing to fill / build / repair. Always
//  "acts" (returns true): a worker with energy and no other task keeps the controller from
//  downgrading. Shared-ready — the dedicated Upgrader role can adopt this same conduct later.
// ============================================================================
export class Upgrade extends Behavior {
  static run(creep, colony) {
    this.note(creep, "work:upgrade");
    if (creep.upgradeController(colony.controller) === ERR_NOT_IN_RANGE) {
      creep.travelTo(colony.controller);
    }
    return true;
  }
}
