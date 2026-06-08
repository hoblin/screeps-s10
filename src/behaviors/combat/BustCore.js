import { CombatBehaviour } from "./CombatBehaviour.js";
import { Engage } from "./Engage.js";
import { strike, holdAnchor } from "./atoms/acts.js";
import { routeToRoom } from "../../lib/Transit.js";

// ============================================================================
//  BustCore (#259) — the anti-core conduct, and the first concrete mission of the
//  OperationalMilitaryOverlord: travel to the assigned remote (memory.target), grind down the invader
//  core squatting it, then garrison the controller so a fresh core can't re-seize while our reserver
//  re-takes it. Proves the operational threat → composition → spawn → lead pipeline against a live
//  trigger (a core reserving our E13S5, kicking the reserver and killing mining).
//
//  Doctrine (combat-doctrine-counters-per-threat §1): an L0 remote core has 100k HP, NO tower, NO
//  defenders — nothing fires back, so the buster is cheap pure-ATTACK (no kite, no heal) that just
//  stands and grinds. RESPECT the invulnerability window: a fresh core is invulnerable (EFFECT_-
//  INVULNERABILITY) — attacking it then wastes hits, so HOLD adjacent and wait it out. The overlord's
//  worthwhileness gate already skips a core that self-collapses before we could arrive + grind; this is
//  the live, on-arrival re-check (we have vision on-target, the overlord did not).
//
//  Assignment: memory.target (the remote room to clear). The DEFAULT node of the buster's machine;
//  selfDefense rides alongside as the only override (en-route survival), so it needs no edges itself.
// ============================================================================
export class BustCore extends CombatBehaviour {
  static run(creep, colony) {
    const room = creep.memory.target;
    if (!room) return false; // unassigned → nothing to bust

    if (creep.room.name !== room) {
      // Danger-/swamp-aware committed transit (#230): route around hot/towered rooms (clearing a
      // winnable hot one in passing), one engine path so the body never yo-yos on a swampy border.
      if (routeToRoom(creep, room, { allowUnscouted: false, clearer: creep })) {
        this.note(creep, "bust:to-room");
        return true;
      }
      this.note(creep, "bust:blocked"); // no safe corridor → fight what's here, don't walk blind
      return Engage.run(creep, colony);
    }

    const core = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    })[0];

    if (!core) {
      // Core dead/gone → garrison the controller so a fresh core can't re-seize while the reservation
      // decays back to us and our reserver re-takes it (mining then resumes on its own).
      const ctrl = creep.room.controller;
      if (ctrl && holdAnchor(creep, ctrl, 1)) this.note(creep, "bust:to-controller");
      else this.note(creep, "bust:deny");
      return true;
    }

    if (this.invulnerable(core)) {
      // Can't be hurt yet — sit next to it and wait the window out rather than waste hits.
      this.note(creep, "bust:wait-invuln");
      holdAnchor(creep, core, 1);
      return true;
    }

    this.note(creep, "bust:grind");
    strike(creep, core); // close + melee by body (self-heal is a no-op on a heal-less buster; the core never hits back)
    return true;
  }

  // Is the core under an active invulnerability effect right now? Read LIVE — the buster has vision
  // on-target (the overlord's pre-dispatch gate reads the same effect from stored intel timers).
  static invulnerable(core) {
    return (core.effects || []).some((e) => e.effect === EFFECT_INVULNERABILITY && e.ticksRemaining > 0);
  }
}
