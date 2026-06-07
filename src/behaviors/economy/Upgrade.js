import { Behavior } from "../Behavior.js";

// ============================================================================
//  Upgrade (#239) — economy atom: pump the controller. The worker's idle fallback — last in
//  the work chain, so it runs only when there's nothing to fill / build / repair. Always
//  "acts" (returns true): a worker with energy and no other task keeps the controller from
//  downgrading. Shared-ready — the dedicated Upgrader role can adopt this same conduct later.
//
//  COLONY-OPTIONAL (#242): a pioneer (colony null) upgrades the room it stands in (creep.room),
//  so excess bootstrap energy compounds the child's controller toward RCL3 instead of idling.
// ============================================================================
export class Upgrade extends Behavior {
  static run(creep, colony) {
    const controller = colony?.controller ?? creep.room.controller;
    if (!controller) return false; // no controller in view — let the chain fall through
    this.note(creep, "work:upgrade");
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      creep.travelTo(controller);
    }
    return true;
  }
}
