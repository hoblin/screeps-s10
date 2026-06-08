import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";
import { Shoot } from "./Shoot.js";
import { Reposition } from "./Reposition.js";
import { GroupHeal } from "./GroupHeal.js";
import { compound } from "../combinators.js";
import { armedOf, focusTarget } from "./atoms/selectors.js";

// ============================================================================
//  FocusFire — the squad's answer to a HEALING enemy squad: spread damage gets out-healed, so every member
//  bursts the SAME pick — the highest kill-priority hostile, HEALER-FIRST (#276) — which each computes
//  independently from `focusTarget` → they converge with no coordinator. Killing the healer collapses the
//  squad; trimming attackers while it heals is the stalemate.
//
//  Owns the focus TARGET POLICY and delegates execution to the kite tree `compound(Shoot, Reposition,
//  GroupHeal)`: a SINGLE-target burst on the focus (no mass-blast — focus-fire concentrates damage), kiting
//  away from ALL armed threats (not just the focus — else it walks into another shooter's fire, #276), and
//  pooling the squad's heal each tick. Melee takes the focus tile (priority:1) so the burst lands same-tick.
//  With nothing targetable, drops to the Engage nucleus (mop stragglers / heal / hold).
//
//  Doubles as an OVERRIDE node (entry/exit edges): drop it over a positional default and the creep snaps to
//  focus-fire on contact, returns to its default when the room clears of armed/healing hostiles.
// ============================================================================
export class FocusFire extends CombatBehaviour {
  // Entry: a targetable hostile (armed OR a healer) is present. Exit: none remain.
  static enteredWhen(creep, _colony) {
    return focusTarget(creep.room.find(FIND_HOSTILE_CREEPS)) !== null;
  }
  static exitWhen(creep, _colony) {
    return focusTarget(creep.room.find(FIND_HOSTILE_CREEPS)) === null;
  }

  static run(creep, colony) {
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const target = focusTarget(hostiles);
    if (!target) return Engage.run(creep, colony); // nothing armed/healing → nucleus mops / heals / holds

    // KITE from ALL armed threats so we hold reach from every shooter, not just the focus (#276). ALWAYS
    // include the focus in the kite set — else a lone/disarmed HEALER focus leaves an empty threat list and
    // the unit never closes to shooting range; with the healer in the set the kite closes on it.
    const armed = armedOf(hostiles);
    const threats = armed.includes(target) ? armed : [...armed, target];
    this.note(creep, `focus:${creep.getActiveBodyparts(ATTACK) > 0 ? "melee" : "ranged"}`);
    // Single-target burst (no crowd mass-blast — concentrate on the focus); melee takes the tile (priority:1)
    // so the squad's burst lands same-tick.
    return compound(creep, colony, [Shoot, Reposition, GroupHeal], {
      target,
      threats,
      meleeOpts: { priority: 1 },
    });
  }
}
