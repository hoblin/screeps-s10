import { CombatBehaviour } from "./CombatBehaviour.js";
import { selfHeal, skirmish } from "./atoms/acts.js";
import { armedOf } from "./atoms/selectors.js";

// ============================================================================
//  Engage (#189) — the umbrella combat conduct atom: "fight whatever is here".
//  Self-heal, find the hostiles, target the closest ARMED one (mop the nearest
//  harmless only when none are armed), and execute by body — melee strike, or ranged
//  shoot + kite. Returns the atom contract bool: true if there were hostiles
//  (engaged), false if the room is clear — the load-bearing signal composing behaviors
//  dispatch on (holdPoint garrisons / holdGround holds / raidRoom razes when false).
//
//  The shared combat nucleus, on no role: reused by holdPoint, holdGround, raidRoom,
//  freeHunter (and FocusFire's no-armed fallback). It also stamps lastEngaged + foughtOwner.
//
//  `ctx` (optional, from a composing behavior):
//   • ctx.threats     — the hostile list to consider (else self-scan the room)
//   • ctx.ownerFilter — restrict combat to ONE player's creeps (#140 en-route hunt)
//   • ctx.target      — fight this exact creep (else armed-nearest)
// ============================================================================
export class Engage extends CombatBehaviour {
  static run(creep, _colony, ctx) {
    selfHeal(creep);
    let hostiles = ctx?.threats ?? creep.room.find(FIND_HOSTILE_CREEPS);
    if (ctx?.ownerFilter) hostiles = hostiles.filter((h) => h.owner && h.owner.username === ctx.ownerFilter);
    if (!hostiles.length) return false;

    // In combat this tick — stamp the contact for the post-clear hold (the HoldGround node keys its
    // entry/exit window off this, so a guard holds the contested ground after clearing — #160).
    creep.memory.lastEngaged = Game.time;

    const armed = armedOf(hostiles);
    const engageable = armed.length ? armed : hostiles;
    const target = ctx?.target ?? creep.pos.findClosestByRange(engageable);

    // Remember the armed attacker's owner for sunk-asset retaliation (#140) — harmless stragglers
    // don't earn revenge, and we don't re-stamp while a retaliation is locked (targetOwner set: the
    // raidRoom edge), which could invalidate the locked target. Read by GuardOverlord (retaliation
    // dispatch) and the raidRoom en-route owner-hunt.
    if (armed.length && target.owner && !creep.memory.targetOwner) {
      creep.memory.foughtOwner = target.owner.username;
    }

    // Dispatch by body via the shared skirmish act — the body IS the source of truth for combat
    // mode: an ATTACK part → melee strike, else ranged shoot + kite (mass-blast in a crowd).
    this.note(creep, `engage:${skirmish(creep, target, engageable, { crowd: hostiles.length > 1 })}`);
    return true;
  }
}
