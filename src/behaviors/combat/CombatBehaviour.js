import { Behavior } from "../Behavior.js";
import { combatBody } from "../../lib/CombatBody.js";

// ============================================================================
//  CombatBehaviour — the combat specialization of the neutral Behavior base (#204).
//
//  Combat was the FIRST behavior tenant, so combat-only defaults once sat on the
//  base. With economy now a second tenant they belong here instead, leaving the
//  base domain-neutral: every combat behavior (raidRoom/holdPoint/focusFire/
//  kiteScreen/engage/…) extends THIS, not Behavior directly.
//
//  It adds two combat concerns:
//   • the ranged-kite body default (RANGED_ATTACK + self-heal + MOVE) — the right
//     shape for every offensive/positional combat behavior; a behavior with a
//     DIFFERENT need still overrides bodyFor (e.g. HealGroup → a heal body).
//   • the warband squad helpers the cohesion behaviors (HealGroup / Regroup /
//     FocusFire / KiteScreen) coordinate through.
// ============================================================================
export class CombatBehaviour extends Behavior {
  // The combat body default: ranged-kite (RANGED_ATTACK + self-heal + MOVE) from the shared sizer.
  static bodyFor(energyBudget) {
    return combatBody(energyBudget, { attack: 0, ranged: 1, heal: 0, tough: 0 });
  }

  // Fellow warband members — my live creeps sharing this creep's `memory.warband`
  // group tag (excluding itself). The lightweight grouping the squad behaviors
  // coordinate through; absent tag → no group.
  static warbandMates(creep) {
    const tag = creep.memory.warband;
    if (!tag) return [];
    return Object.values(Game.creeps).filter(
      (c) => c.memory.warband === tag && c.name !== creep.name
    );
  }

  // The point to regroup toward to stay with the squad: the nearest mate in THIS
  // room, else any mate (travelTo handles the cross-room hop). Null with no group.
  static groupAnchor(creep) {
    const mates = this.warbandMates(creep);
    if (!mates.length) return null;
    const here = mates.filter((c) => c.room.name === creep.room.name);
    return here.length ? creep.pos.findClosestByRange(here) : mates[0];
  }
}
