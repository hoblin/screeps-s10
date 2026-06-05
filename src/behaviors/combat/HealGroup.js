import { Behavior } from "../Behavior.js";

// ============================================================================
//  HealGroup — the dedicated HEALER archetype (no offence). Sustains the squad:
//  each tick it heals the most-hurt ally (preferring fellow warband members),
//  full-heal when adjacent, ranged-heal on the move; with nobody hurt it tails the
//  group to stay in heal range. This is the piece a lone guard structurally can't
//  be — and the reason a HEALING enemy squad beats single guards. Pair it with
//  FocusFire members and the warband out-sustains AND out-bursts that squad.
//
//  Assignment: memory.warband — the group tag it heals + follows (set by #174).
// ============================================================================
export class HealGroup extends Behavior {
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
    // Nobody hurt in range — stay with the group so we're in reach when they take hits.
    const anchor = this.groupAnchor(creep);
    if (anchor && !creep.pos.inRangeTo(anchor, 1)) {
      this.note(creep, "heal:regroup");
      creep.travelTo(anchor, { range: 1 });
    } else {
      this.note(creep, "heal:idle");
    }
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
