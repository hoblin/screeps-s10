import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";

const GUARD_PARK_DELAY = 5; // hold the contested ground this many ticks after the last contact before
// returning to the post — long enough to shoot a harasser that ducks across the border and returns (#160).

// ============================================================================
//  HoldGround (#160) — the post-combat hold node: for a few ticks after a fight, hold the GROUND where
//  it ended (no walk-back) and re-engage anything that wanders in, instead of trotting back to the post
//  and re-chasing a harasser that ducks across the border and returns (the old controller↔border
//  oscillation). Peacetime garrison is the DEFAULT (holdPoint, on the post); this node owns only the
//  brief aftermath, so the two responsibilities stay separate.
//
//  A machine node over a positional default: enters while a recent contact is fresh AND we're in our
//  assigned room (an en-route skirmish must NOT pin transit — that stays the default's job); exits when
//  the hold window lapses. `lastEngaged` is stamped by the Engage atom on every combat tick, so a
//  returner that walks back in refreshes the window through this node's own engage.
// ============================================================================
export class HoldGround extends CombatBehaviour {
  static enteredWhen(creep, _colony) {
    return creep.room.name === creep.memory.target && this.recentlyEngaged(creep);
  }
  static exitWhen(creep, _colony) {
    return !this.recentlyEngaged(creep); // window lapsed → back to the post (holdPoint)
  }

  static run(creep, colony) {
    if (Engage.run(creep, colony)) return true; // a returner walked in → fight it (refreshes the window)
    this.note(creep, "guard:hold-ground"); // clear → hold THIS tile (register no move), don't walk back yet
    return true;
  }

  // Within the post-engagement window: true for GUARD_PARK_DELAY clear ticks after the last contact.
  // `<=` so a delay of 5 yields a full 5 clear ticks (lastEngaged is the LAST contact tick, the first
  // clear tick already reads `now - last == 1`).
  static recentlyEngaged(creep) {
    const last = creep.memory.lastEngaged;
    return last !== undefined && Game.time - last <= GUARD_PARK_DELAY;
  }
}
