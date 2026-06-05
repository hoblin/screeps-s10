import { Behavior } from "../Behavior.js";
import { Guard } from "../../roles/Guard.js";

// ============================================================================
//  KiteScreen — the ranged ATTACKER archetype: stay at RANGED_ATTACK reach,
//  shoot, and kite back the instant anything closes — screening the squad's softer
//  members (the healer) from melee while chipping the enemy. Pure reuse of the
//  Guard ranged-kite nucleus (engage + kiteAway) forced onto the ranged branch.
//  With no threats present it regroups toward the warband so it keeps screening
//  rather than wandering.
//
//  Assignment: memory.warband — the group tag to regroup toward (set by #174).
// ============================================================================
export class KiteScreen extends Behavior {
  static run(creep, _colony) {
    // Prefer the ranged-kite branch (the screen's whole point) — but only if the body can
    // actually shoot. A creep with no RANGED_ATTACK (e.g. a melee body wrongly retasked here)
    // falls back to its body-derived mode so it still deals damage instead of flailing at range.
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) creep.memory.guardType = "ranged";
    else this.ensureCombatMode(creep);
    if (Guard.engage(creep)) return; // threats present → shoot + kite the nearest

    // No threats: stay near the squad (within a tile of screening range).
    const anchor = this.groupAnchor(creep);
    if (anchor && !creep.pos.inRangeTo(anchor, 2)) {
      this.note(creep, "kite:regroup");
      creep.travelTo(anchor, { range: 2 });
    } else {
      this.note(creep, "kite:hold");
    }
  }
}
