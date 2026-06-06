import { Behavior } from "../Behavior.js";
import { holdAnchor } from "./atoms/acts.js";
import { armedOf } from "./atoms/selectors.js";
import { bodyFromTemplate } from "../../lib/BodyGenerator.js";

const HEAL_MAX = 6; // [HEAL,MOVE] repeats cap — at ecap 1800 the budget caps it here anyway

// ============================================================================
//  HealGroup — the dedicated HEALER archetype (no offence). Sustains the squad:
//  each tick it heals the most-hurt ally (preferring fellow warband members),
//  full-heal when adjacent, ranged-heal on the move; with nobody hurt it tails the
//  ARMED element (the skirmishers it must keep alive). This is the piece a lone
//  guard structurally can't be — and the reason a HEALING enemy squad beats single
//  guards. Pair it with FocusFire members and the warband out-sustains AND out-bursts
//  that squad.
//
//  Assignment: memory.warband — the group tag it heals + follows (set by #174).
// ============================================================================
export class HealGroup extends Behavior {
  // A healer's body (MVC: the behavior owns its body) — 1:1 HEAL:MOVE so it keeps full road speed
  // with the skirmishers it escorts. Overrides the base ranged-combat default.
  static bodyFor(energyBudget) {
    return bodyFromTemplate([HEAL, MOVE], { extra: [HEAL, MOVE], max: HEAL_MAX, energy: energyBudget });
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
      return;
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

  // The most-hurt ally to mend: prefer fellow warband members, else any of my creeps
  // in the room; lowest hits-ratio first. Healing is room-local, so only consider
  // creeps in this room (cross-room mates are reached via groupAnchor regroup).
  static mostHurtInRoom(creep) {
    const pool = creep.room.find(FIND_MY_CREEPS).filter((c) => c.hits < c.hitsMax);
    if (!pool.length) return null;
    const tag = creep.memory.warband;
    const mates = tag ? pool.filter((c) => c.memory.warband === tag) : [];
    const choose = mates.length ? mates : pool;
    return choose.sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
  }
}
