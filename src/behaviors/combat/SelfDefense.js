import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";
import { armedOf } from "./atoms/selectors.js";

const SELF_DEFENSE_RANGE = 4; // melee(1) + ranged(3) reach + one enemy step: an armed hostile THIS close is
// actively able to hit us. Distant ones don't trigger it — anti-Leeroy (#182): defend yourself, don't chase.

// ============================================================================
//  SelfDefense (#232) — the en-route survival OVERRIDE. A unit committed to a transit default
//  (holdPoint / holdPosition / raidRoom heading to a far objective) WALKS PAST hostiles in
//  pass-through rooms — that's the #182 anti-Leeroy doctrine (don't divert to chase every enemy
//  on the way to the objective). But self-preservation is NOT diversion: when an ARMED hostile gets
//  close enough to hit it, this node preempts transit, fights it by body (the shared Engage nucleus,
//  SCOPED to the in-range threats so it can't be lured off its route — the killClosest principle),
//  then RELEASES back to the default the instant the threat is dead/fled OR the unit arrives —
//  resuming the committed route from wherever the fight left it (routeToRoom re-paths cleanly).
//
//  Scoped to TRANSIT (room != destination): at the destination the positional behaviours own the
//  fight room-wide with their own conduct (holdPosition's magnet field, raidRoom's raze, holdPoint's
//  garrison) — this node must NOT clobber them. With NO destination (an untasked freeHunter) it stays
//  off entirely, so a roaming hunter keeps its room-wide engage. Placed FIRST in a role's `nodes` list
//  = highest priority: self-preservation preempts every mission node, then hands control straight back.
// ============================================================================
export class SelfDefense extends CombatBehaviour {
  static enteredWhen(creep, _colony) {
    const dest = this.destRoom(creep);
    return !!dest && creep.room.name !== dest && this.threats(creep).length > 0;
  }
  static exitWhen(creep, _colony) {
    const dest = this.destRoom(creep);
    return !dest || creep.room.name === dest || this.threats(creep).length === 0;
  }

  // Fight the close armed threats via the shared nucleus (self-heal + by-body skirmish + lastEngaged
  // stamp), passed as ctx.threats so it strikes/kites only the in-range attackers — never drifts after a
  // distant lure (the room-wide Engage would; scoping it here is what keeps transit on its leash).
  static run(creep, colony) {
    return Engage.run(creep, colony, { threats: this.threats(creep) });
  }

  // Armed hostiles within striking distance of THIS unit (same room only — findInRange is room-local).
  static threats(creep) {
    return armedOf(creep.pos.findInRange(FIND_HOSTILE_CREEPS, SELF_DEFENSE_RANGE));
  }

  // Where the unit is headed (its transit destination): an explicit pin, else the assigned room.
  static destRoom(creep) {
    return creep.memory.point?.roomName ?? creep.memory.target;
  }
}
