import { Behavior } from "../Behavior.js";
import { selfHeal, shoot, kiteStep, meleeHit } from "./atoms/acts.js";
import { armedOf } from "./atoms/selectors.js";

// ============================================================================
//  Engage (#189) — the umbrella combat conduct atom: "fight whatever is here".
//  Self-heal, find the hostiles, target the closest ARMED one (mop the nearest
//  harmless only when none are armed), and execute by body — melee strike, or ranged
//  shoot + kite. Returns the atom contract bool: true if there were hostiles
//  (engaged), false if the room is clear — the load-bearing signal callers dispatch
//  on (Guard garrisons / Escort follows / RaidRoom holds the controller when false).
//
//  This is the nucleus lifted off the Guard role so nothing imports Guard for combat.
//  Reused by Guard.run, Escort, HoldPoint, RaidRoom (and FocusFire's no-armed fallback).
//
//  `ctx` (optional, from a composing behavior):
//   • ctx.threats     — the hostile list to consider (else self-scan the room)
//   • ctx.ownerFilter — restrict combat to ONE player's creeps (#140 en-route hunt)
//   • ctx.target      — fight this exact creep (else armed-nearest)
// ============================================================================
export class Engage extends Behavior {
  static run(creep, _colony, ctx) {
    selfHeal(creep);
    let hostiles = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (ctx?.ownerFilter) hostiles = hostiles.filter((h) => h.owner && h.owner.username === ctx.ownerFilter);
    if (!hostiles.length) return false;

    const armed = armedOf(hostiles);
    const engageable = armed.length ? armed : hostiles;
    const target = ctx?.target ?? creep.pos.findClosestByRange(engageable);

    // Remember the armed attacker's owner for sunk-asset retaliation (#140) — harmless
    // stragglers don't earn revenge, and we don't re-stamp while a mission is locked
    // (it could invalidate the locked target and drop a valid mission). Read by Guard.run
    // (the en-route hunt) and GuardOverlord (retaliation dispatch).
    if (armed.length && target.owner && !creep.memory.retaliationMission) {
      creep.memory.foughtOwner = target.owner.username;
    }

    // Dispatch by body (matches Behavior.ensureCombatMode): an ATTACK part → melee, else
    // ranged. Equivalent to the spawn-set guardType for every non-mixed body we field.
    if (creep.getActiveBodyparts(ATTACK) > 0) {
      this.note(creep, "engage:melee");
      meleeHit(creep, target);
    } else {
      this.note(creep, "engage:ranged");
      shoot(creep, target, hostiles.length > 1);
      kiteStep(creep, target, engageable);
    }
    return true;
  }
}
