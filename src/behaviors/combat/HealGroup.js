import { CombatBehaviour } from "./CombatBehaviour.js";
import { holdAnchor } from "./atoms/acts.js";
import { armedOf } from "./atoms/selectors.js";
import { healerBody } from "../../lib/CombatBody.js";

// ============================================================================
//  HealGroup — the dedicated HEALER archetype (no offence). Sustains the squad: each tick it heals the
//  most-hurt squadmate (room-wide, crossing to a hurt mate out of reach — broader than the range-3
//  `groupHeal` a skirmisher pools), full-heal when adjacent, ranged-heal on the move; with nobody hurt it
//  tails the ARMED element (the skirmishers it must keep alive). This is the piece a lone guard structurally
//  can't be — and the reason a HEALING enemy squad beats single guards. Pair it with FocusFire members and
//  the group out-sustains AND out-bursts that squad. The medic NODE = follow-or-tend ⊕ heal (the move
//  channel picks tend-the-hurt over follow-the-lead; the heal channel fires alongside).
//
//  Assignment: memory.warband || memory.mission — the squad it heals + follows (manual tag or auto mission).
// ============================================================================
export class HealGroup extends CombatBehaviour {
  // A healer's body (MVC: the behavior owns its body) — delegated to the shared sizer so the medic body is
  // single-sourced with the mission roster that fields it. 1:1 HEAL:MOVE, full road speed with its escort.
  static bodyFor(energyBudget) {
    return healerBody(energyBudget);
  }

  static run(creep, _colony) {
    const hurt = this.mostHurtInRoom(creep);
    if (hurt) {
      this.note(creep, "heal:heal");
      // Adjacent → full heal (12/part); at range → ranged heal (4/part) while closing.
      if (creep.pos.getRangeTo(hurt) <= 1) creep.heal(hurt);
      else {
        creep.rangedHeal(hurt);
        creep.travelTo(hurt, { range: 1 });
      }
      return true;
    }
    // Nobody hurt — glue to the ARMED element (the skirmishers), following it across rooms. Anchoring
    // on the combat creeps (not just the nearest mate) is what keeps the medic IN the fight: it never
    // races ahead to an objective and abandons the skirmishers, and never clumps with fellow medics
    // a room behind. Stays at range 1 so it can full-heal the instant they take a hit.
    const lead = this.followLead(creep);
    if (lead && holdAnchor(creep, lead, 1)) {
      this.note(creep, lead.room.name === creep.room.name ? "heal:regroup" : "heal:to-room");
    } else {
      this.note(creep, "heal:idle");
    }
    return true;
  }

  // The squadmate to follow: prefer an ARMED mate (a skirmisher — the muscle the medic exists to
  // sustain) over a fellow medic; nearest in-room, else any armed mate for the cross-room hop. Falls
  // back to any mate (an all-medic group with nothing to escort). Null with no group.
  static followLead(creep) {
    const mates = this.warbandMates(creep);
    if (!mates.length) return null;
    const armed = armedOf(mates);
    const pool = armed.length ? armed : mates;
    const here = pool.filter((c) => c.room.name === creep.room.name);
    return here.length ? creep.pos.findClosestByRange(here) : pool[0];
  }

  // The most-hurt ally to mend: prefer fellow squadmates (warband || mission), else any of my creeps in
  // the room; lowest hits-ratio first. Healing is room-local, so only consider creeps in this room
  // (cross-room mates are reached via the follow-lead regroup).
  static mostHurtInRoom(creep) {
    const pool = creep.room.find(FIND_MY_CREEPS).filter((c) => c.hits < c.hitsMax);
    if (!pool.length) return null;
    const squad = creep.memory.warband || creep.memory.mission;
    const mates = squad ? pool.filter((c) => (c.memory.warband || c.memory.mission) === squad) : [];
    const choose = mates.length ? mates : pool;
    return choose.sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
  }
}
