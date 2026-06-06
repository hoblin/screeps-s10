import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";
import { skirmish } from "./atoms/acts.js";
import { armedOf, lowestHitsArmed } from "./atoms/selectors.js";

// ============================================================================
//  FocusFire — the squad's answer to a HEALING enemy squad: spread damage gets
//  out-healed, so every member bursts the SAME pick (the lowest-hits armed hostile,
//  id-tiebroken) which each computes independently → they converge with no coordinator.
//
//  Composes the shared acts on its OWN target (not engage's armed-nearest): melee closes
//  at priority 1 to take the tile so the burst lands same-tick; ranged shoots a single
//  aimed shot and kites away from the FOCUS target only. With nothing armed, it drops to
//  the Engage nucleus (mop stragglers / self-heal / hold).
//
//  Doubles as an OVERRIDE node (entry/exit edges): drop it over a positional default and
//  the creep snaps to focus-fire on contact, returns to its default when the room clears.
// ============================================================================
export class FocusFire extends CombatBehaviour {
  // Entry: an armed hostile is present. Exit: the room is clear of armed hostiles.
  static enteredWhen(creep, _colony) {
    return this.armed(creep).length > 0;
  }
  static exitWhen(creep, _colony) {
    return this.armed(creep).length === 0;
  }

  static run(creep, colony) {
    const target = lowestHitsArmed(creep.room.find(FIND_HOSTILE_CREEPS));
    if (!target) return Engage.run(creep, colony); // nothing armed → nucleus mops / heals / holds

    // Skirmish the single focus pick: melee takes the tile (priority:1) so the burst lands same-tick;
    // ranged fires ONE aimed shot (no crowd mass — concentrate on ONE) and kites from the focus alone.
    this.note(creep, `focus:${skirmish(creep, target, [target], { meleeOpts: { priority: 1 } })}`);
    return true;
  }

  static armed(creep) {
    return armedOf(creep.room.find(FIND_HOSTILE_CREEPS));
  }
}
