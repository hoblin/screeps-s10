import { Role } from "./Role.js";
import { BehaviorMachine } from "../behaviors/BehaviorMachine.js";

// ============================================================================
//  Hunter — the SOLO aggressive clearer (#187), retiring the scout-escort pairing. A thin state
//  machine (like every role under the behaviour layer): no bait-scout, no follow. It travels to an
//  assigned scout-blocker room, clears it via the field (its own presence is the vision that resets
//  scoutThreat → reopens the sector), then — with no blocker left — freeHunts the colony's remotes,
//  killing hostiles instead of recycling. Never wasted, never sent home to die in transit.
//
//  Machine `{ default: "holdPoint", nodes: ["freeHunter"] }`, steered by ScoutOverlord writing
//  memory.target: holdPoint(target=blocker) goes and clears the blocker; when the blocker is cleared
//  the overlord nulls target and freeHunter (no objective) roams. ScoutOverlord owns it (role "hunter").
// ============================================================================
export class Hunter extends Role {
  // Combat rank (matches Guard/Combatant): it has somewhere to be, not shoved aside by idlers.
  static movementPriority = 3;

  static run(creep, colony) {
    BehaviorMachine.run(creep, colony);
  }
}
