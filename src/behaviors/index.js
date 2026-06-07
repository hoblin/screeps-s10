import { Behavior } from "./Behavior.js";
import { RaidRoom } from "./combat/RaidRoom.js";
import { HoldPoint } from "./combat/HoldPoint.js";
import { FocusFire } from "./combat/FocusFire.js";
import { HealGroup } from "./combat/HealGroup.js";
import { KiteScreen } from "./combat/KiteScreen.js";
import { KillClosest } from "./combat/KillClosest.js";
import { HoldPosition } from "./combat/HoldPosition.js";
import { Kite } from "./combat/Kite.js";
import { Regroup } from "./combat/Regroup.js";
import { Engage } from "./combat/Engage.js";
import { FreeHunter } from "./combat/FreeHunter.js";
import { RoamNeighbour } from "./combat/RoamNeighbour.js";
import { HoldGround } from "./combat/HoldGround.js";
import { SelfDefense } from "./combat/SelfDefense.js";
import { RemoteHaul } from "./economy/RemoteHaul.js";
import { Work } from "./economy/Work.js";

// ============================================================================
//  Behavior registry (#39) — maps a behavior NAME (as stored in a creep's
//  memory.behaviors set) to its Behavior CLASS. The catalog a warband draws
//  from; the BehaviorMachine resolves names through here each tick. Mirrors the
//  role registry (src/roles/index.js): a name→class map + one resolver.
//
//  ARCHETYPES (the combat catalog — classic RPG/strategy roles, composable):
//   • raidRoom   — offence: travel to a target room, hunt a locked owner en route,
//                  deny the room (melee or ranged by body).
//   • holdPoint  — defence: garrison an assigned point/room, engage intruders.
//   • focusFire  — the answer to a HEALING squad: ALL members burst ONE shared
//                  target (lowest-hits) to out-pace sustained heal. Carries
//                  entry/exit edges, so it doubles as an override node over a
//                  positional default (hold → focus on contact → back to hold).
//   • healGroup  — the dedicated HEALER: no offence, sustains the most-hurt ally
//                  (the piece a lone guard structurally can't be).
//   • kiteScreen — the ranged ATTACKER: shoot at reach, kite back on contact,
//                  screening the squad's softer members.
//   • killClosest — lure-proof area denial: attack the NEAREST hostile (any kind),
//                  anchored, never chasing the bait — the counter to a kiting harasser
//                  that pulls the squad off the economy it's screening.
//   • holdPosition — PIN to coordinates, spread in a group-sized radius (no tile-fight),
//                  engage what enters the zone, stray briefly to strike then return —
//                  garrison a chokepoint/kill-zone without drifting off it.
//
//  A buffer/booster archetype is a future slot (needs labs/boosts — Stage 4).
//
//  ATOMS (#188 — the reusable bricks composites are built from; also assignable on
//  their own, since the only thing separating an atom from a composite is whether it
//  calls other behaviors):
//   • engage  — the umbrella combat nucleus: fight whatever is here (armed-first), by body.
//   • kite    — ranged-combat conduct: shoot at reach, step back on contact, close if far.
//   • regroup — squad cohesion: converge on the warband anchor when there's nothing to fight.
//   • freeHunter — the never-wasted sink: no objective → roam the colony's remotes and kill all
//                  hostiles (= fallback(engage, roamNeighbour)). The edge a released combat unit
//                  takes INSTEAD of recycling; entry/exit key off memory.target.
//   • roamNeighbour — freeHunter's sweep leg: patrol the protected remotes in turn (danger-aware).
//   • holdGround — the post-combat hold (#160): hold the contested spot for a few ticks after a fight
//                  and re-engage returners, before walking back to the post. A node over holdPoint.
//   • selfDefense — en-route survival OVERRIDE (#232): a TRANSITING unit preempts its route to fight an
//                  ARMED hostile that gets close enough to hit it (in-range only — defend, don't chase),
//                  then resumes. Entry/exit edges; scoped to transit so it never clobbers a destination's
//                  own conduct. Place FIRST in a role's nodes (self-preservation preempts the mission).
//
//  ECONOMY (#204 — the first non-combat behaviors; extend the neutral Behavior base directly):
//   • remoteHaul — carry a remote source's energy home. Executes the source the
//                  RemoteLogisticsOverlord stamps (command pattern); the overlord balances
//                  the fleet across containers (rate-matched tonne-km, no swarm).
//   • work       — the general builder/filler/repairer/upgrader (#239). Gather↔work cycle
//                  (shared Hauler.runCycle); when spending, a `fallback` of self-gating atoms
//                  fill > build > repair > upgrade. Build SITE selection is the WorkOverlord's
//                  (it stamps memory.buildTarget, fleet-concentrated + per-trip latched) — the
//                  Build atom only executes the stamp. The atoms (fillStructures/build/repair/
//                  upgrade) are composed internally, not assignable by name, so they're not registered.
// ============================================================================
export const BEHAVIORS = {
  raidRoom: RaidRoom,
  holdPoint: HoldPoint,
  focusFire: FocusFire,
  healGroup: HealGroup,
  kiteScreen: KiteScreen,
  killClosest: KillClosest,
  holdPosition: HoldPosition,
  engage: Engage,
  kite: Kite,
  regroup: Regroup,
  freeHunter: FreeHunter,
  roamNeighbour: RoamNeighbour,
  holdGround: HoldGround,
  selfDefense: SelfDefense,
  remoteHaul: RemoteHaul,
  work: Work,
};

// Resolve a behavior name to its class, or null (an unknown/typo'd name is a no-op
// rather than a throw — the machine just runs nothing that tick).
export function behaviorClass(name) {
  return BEHAVIORS[name] || null;
}

export { Behavior };
