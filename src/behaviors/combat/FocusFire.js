import { Behavior } from "../Behavior.js";
import { Guard } from "../../roles/Guard.js";
import { Threat } from "../../lib/Threat.js";

const KITE_RANGE = 3; // RANGED_ATTACK reach — a ranged member fights from exactly here

// ============================================================================
//  FocusFire — the squad's answer to a HEALING squad (the class a lone guard
//  can't beat). Spread damage across targets gets out-healed; CONCENTRATED burst
//  on ONE target overwhelms the heal. So every member fires at the SAME pick —
//  the armed hostile with the lowest hits (closest to death), id-tiebroken — which
//  each creep computes independently, so they converge with NO coordinator. Burst
//  beats sustained heal. Body-agnostic: melee closes, ranged shoots + kites.
//
//  Doubles as an OVERRIDE node (paired entry/exit edges): drop it into a creep's
//  `nodes` over a positional default (holdPoint / kiteScreen) and the creep holds
//  normally, snaps to focus-fire the instant an armed hostile appears, and returns
//  to its default when the room is clear. As a `default` node the edges are ignored.
// ============================================================================
export class FocusFire extends Behavior {
  // Entry edge: an armed hostile is present (something worth concentrating on).
  static enteredWhen(creep, _colony) {
    return this.armedHostiles(creep).length > 0;
  }

  // Exit edge: the room is clear of armed hostiles — release back to the default.
  static exitWhen(creep, _colony) {
    return this.armedHostiles(creep).length === 0;
  }

  static run(creep, colony) {
    const mode = this.ensureCombatMode(creep);
    const target = this.focusTarget(creep);
    if (!target) {
      // Nothing armed to burst — fall back to the shared nucleus (mops harmless
      // stragglers / self-heals / holds). Keeps a focusFire-only creep useful.
      Guard.engage(creep);
      return;
    }

    if (mode === "melee") {
      this.note(creep, "focus:melee");
      // Priority 1 on the close: a focusing creep takes the tile from idlers so the
      // squad lands its burst on the same tick rather than tripping over each other.
      if (creep.attack(target) === ERR_NOT_IN_RANGE) creep.travelTo(target, { range: 1, priority: 1 });
      return;
    }

    // Ranged: shoot the shared target from reach, kite back if it closes.
    this.note(creep, "focus:ranged");
    const range = creep.pos.getRangeTo(target);
    if (range <= KITE_RANGE) creep.rangedAttack(target);
    if (range < KITE_RANGE) Guard.kiteAway(creep, [target]);
    else if (range > KITE_RANGE) creep.travelTo(target, { range: KITE_RANGE });
  }

  // The deterministic shared focus target: the lowest-hits ARMED hostile in the
  // room, tie-broken by id so every member picks the SAME one with no coordination.
  static focusTarget(creep) {
    const armed = this.armedHostiles(creep);
    if (!armed.length) return null;
    return armed.sort((a, b) => a.hits - b.hits || (a.id < b.id ? -1 : 1))[0];
  }

  static armedHostiles(creep) {
    return creep.room.find(FIND_HOSTILE_CREEPS).filter((h) => Threat.combatPower(h) > 0);
  }
}
