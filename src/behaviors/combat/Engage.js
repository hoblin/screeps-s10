import { CombatBehaviour } from "./CombatBehaviour.js";
import { Shoot } from "./Shoot.js";
import { Reposition } from "./Reposition.js";
import { GroupHeal } from "./GroupHeal.js";
import { compound } from "../combinators.js";
import { armedOf, focusTarget } from "./atoms/selectors.js";

// ============================================================================
//  Engage (#189) — the umbrella combat conduct: "fight whatever is here". It owns the TARGET POLICY
//  (scan hostiles, focus the healer else nearest-armed, stamp retaliation bookkeeping) and delegates the
//  EXECUTION to the kite tree `compound(Shoot, Reposition, GroupHeal)` — fire ⊕ reposition ⊕ heal in one
//  tick. Returns the atom contract bool: true if there were hostiles (engaged), false if the room is clear
//  — the load-bearing signal composing behaviors dispatch on (holdPoint/holdGround/raidRoom).
//
//  The shared combat nucleus, on no role: reused by holdPoint, holdGround, raidRoom, freeHunter (and
//  FocusFire's no-armed fallback). It also stamps lastEngaged + foughtOwner.
//
//  `ctx` (optional, from a composing behavior):
//   • ctx.threats     — the hostile list to consider (else self-scan the room)
//   • ctx.ownerFilter — restrict combat to ONE player's creeps (#140 en-route hunt)
//   • ctx.target      — fight this exact creep (else focus-healer / armed-nearest)
// ============================================================================
export class Engage extends CombatBehaviour {
  static run(creep, colony, ctx) {
    let hostiles = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (ctx?.ownerFilter) hostiles = hostiles.filter((h) => h.owner && h.owner.username === ctx.ownerFilter);
    if (!hostiles.length) return false;

    // In combat this tick — stamp the contact for the post-clear hold (HoldGround keys its window off this).
    creep.memory.lastEngaged = Game.time;

    const armed = armedOf(hostiles);
    const engageable = armed.length ? armed : hostiles;
    // FIRE the healer first (deterministic squad focus, #276); fall back to nearest for pure-economy mop-up.
    // The kite still settles at reach from EVERY armed threat (engageable), so we fire one and dodge all.
    const target = ctx?.target ?? focusTarget(hostiles) ?? creep.pos.findClosestByRange(engageable);

    // Remember the armed attacker's owner for sunk-asset retaliation (#140) — harmless stragglers don't
    // earn revenge, and we don't re-stamp while a retaliation is locked (targetOwner set), which could
    // invalidate the locked target. Read by the overlord's retaliation resolve stage (#262).
    if (armed.length && target.owner && !creep.memory.targetOwner) {
      creep.memory.foughtOwner = target.owner.username;
    }

    this.note(creep, `engage:${creep.getActiveBodyparts(ATTACK) > 0 ? "melee" : "ranged"}`);
    // Fire ⊕ reposition ⊕ heal in ONE tick: shoot the focus, kite off the nearest armed threat (settle at
    // reach from every shooter, never caught in stacked fire), pool heal onto whoever's taking the hit.
    return compound(creep, colony, [Shoot, Reposition, GroupHeal], {
      target,
      threats: engageable,
      crowd: hostiles.length > 1,
    });
  }
}
