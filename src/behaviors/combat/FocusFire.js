import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";
import { groupHeal, skirmish } from "./atoms/acts.js";
import { armedOf, focusTarget } from "./atoms/selectors.js";

// ============================================================================
//  FocusFire — the squad's answer to a HEALING enemy squad: spread damage gets out-healed, so every
//  member bursts the SAME pick — the highest kill-priority hostile, HEALER-FIRST (#276) — which each
//  computes independently from `focusTarget` → they converge with no coordinator. Killing the healer
//  collapses the squad; trimming attackers while it heals is the stalemate.
//
//  Composes the shared acts: melee closes at priority 1 to take the tile so the burst lands same-tick;
//  ranged shoots the focus and KITES away from ALL armed threats (not just the focus — else it walks into
//  another shooter's fire, #276). Pools the squad's heal each tick onto whoever's taking fire. With nothing
//  targetable, drops to the Engage nucleus (mop stragglers / heal / hold).
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

    groupHeal(creep); // pool the squad's heal onto whoever's taking fire while we burst the focus
    // Burst the focus pick; KITE from ALL armed threats so we hold reach from every shooter, not just the
    // focus (#276). Melee takes the tile (priority:1) so the squad's burst lands same-tick.
    this.note(creep, `focus:${skirmish(creep, target, armedOf(hostiles), { meleeOpts: { priority: 1 } })}`);
    return true;
  }
}
