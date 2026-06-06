import { Behavior } from "../Behavior.js";
import { Engage } from "./Engage.js";
import { shoot, kiteStep, meleeHit } from "./atoms/acts.js";
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
export class FocusFire extends Behavior {
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

    if (creep.getActiveBodyparts(ATTACK) > 0) {
      this.note(creep, "focus:melee");
      meleeHit(creep, target, { priority: 1 }); // take the tile so the squad's burst lands same-tick
    } else {
      this.note(creep, "focus:ranged");
      shoot(creep, target); // single aimed shot — never mass (concentrate on ONE)
      kiteStep(creep, [target]); // field-kite, keeping range from the focus target
    }
    return true;
  }

  static armed(creep) {
    return armedOf(creep.room.find(FIND_HOSTILE_CREEPS));
  }
}
