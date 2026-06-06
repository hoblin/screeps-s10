import { Behavior } from "../Behavior.js";
import { holdAnchor } from "./atoms/acts.js";

// ============================================================================
//  Regroup (#188) — the squad-cohesion ATOM: with nothing to fight, stay near the
//  warband so a screening unit keeps screening instead of wandering. Moves toward
//  the group anchor (nearest in-room mate, else any mate for the cross-room hop) if
//  beyond 2 tiles of it, else holds.
//
//  A TERMINAL default — it always handles the tick (move toward the squad or hold),
//  so it returns true and sits last in a fallback as the no-combat sink.
// ============================================================================
export class Regroup extends Behavior {
  static run(creep, _colony) {
    const anchor = this.groupAnchor(creep);
    if (anchor && holdAnchor(creep, anchor, 2)) this.note(creep, "kite:regroup");
    else this.note(creep, "kite:hold");
    return true;
  }
}
