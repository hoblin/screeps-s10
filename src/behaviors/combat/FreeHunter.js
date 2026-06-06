import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { RoamNeighbour } from "./RoamNeighbour.js";
import { fallback } from "../combinators.js";

// ============================================================================
//  FreeHunter (#187) — the never-wasted sink: a combat unit with no fixed objective roams the
//  colony's protected remotes and kills everything hostile. = fallback(engage, roamNeighbour):
//  fight whatever is here, else sweep to the next remote (danger-aware). This is the principled
//  replacement for recycling a released/idle combat unit — returning one body's energy is worth
//  far less than denying the area (and the attacker who caused the spawn) in the long run.
//
//  It is the BehaviorMachine's reason to exist: a released unit ENTERS this node (the edge), it is
//  not an `if (!target) recycle` in a role. Entry/exit key off memory.target — the overlord owns the
//  objective (defend a hot room / deny an attacker's remote); clearing it drops the unit to hunting,
//  setting it pulls the unit back to its default conduct.
// ============================================================================
export class FreeHunter extends Behavior {
  // Enter when the overlord has given no objective (mission done / released); exit the moment it does.
  static enteredWhen(creep, _colony) {
    return !creep.memory.target;
  }
  static exitWhen(creep, _colony) {
    return !!creep.memory.target;
  }

  static run(creep, colony) {
    return fallback(creep, colony, [Engage, RoamNeighbour]);
  }
}
