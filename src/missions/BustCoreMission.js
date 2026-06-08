import { Threat } from "../lib/Threat.js";
import { antiCoreBody } from "../lib/CombatBody.js";
import { towerFreeRoute } from "../lib/Routing.js";

const TILES_PER_ROOM = 50; // rough tiles/room → travel ticks for the collapse-timer worthwhileness gate

// ============================================================================
//  BustCoreMission (#259) — the FIRST concrete mission of the OperationalMilitaryOverlord, and the
//  proof of the group spine. A mission owns its whole lifecycle: it recognises its own targets, declares
//  the GROUP to field (a roster of unit-types × counts), and drives that group through a stage machine
//  (muster → deploy → execute → resolve) — the overlord is just the type-agnostic backbone that fields
//  the roster and dispatches members to it.
//
//  bust-core clears an L0 invader core squatting one of our remotes (it reserves the controller, kicking
//  our reserver and killing mining). An L0 core has 100k HP, NO tower, NO defenders — nothing fires back —
//  so the buster is a cheap pure-ATTACK group (see CombatBody.antiCoreBody). Its CONDUCT lives in the
//  `bustCore` behaviour (transit → grind respecting invulnerability → garrison the controller); this class
//  only COMPOSES and LEADS, it never re-codes per-tick tactics.
//
//  It is a concrete class with the stage machine inline. The shared RemoteMission / GarrisonMission bases
//  are deliberately NOT extracted yet (one subclass = a guessed shared surface) — they are pulled out in
//  Slice 2 (#262) when clear-remote / retaliate / defend-home give the second instance.
//
//  Stage shape — a REMOTE mission: muster the full roster at home (replace freely there — it is cheap),
//  deploy as one group, and do NOT replace mid-flight (a lone reinforcement just walks into a corpse). The
//  policy rule is "replace while home, commit when it leaves"; for bust-core's count of 1 the muster is
//  instant, but the machinery is real and ready for count > 1 ("two busters halve the grind").
// ============================================================================
export class BustCoreMission {
  // AUTONOMOUS recogniser (the static factory the overlord's autonomousMissions() aggregates): one mission
  // per remote of OURS seized by a core and worth busting. Recognition is co-located with the mission so
  // each TYPE owns "where do I apply", while the SOURCE only chooses autonomous-vs-manual.
  static autoMissions(colony) {
    const budget = colony.spawnEnergyBudget();
    const rooms = [...new Set(colony.remoteSources().map((s) => s.room))];
    return rooms
      .filter((room) => Threat.coreSeized(room) && this.worthwhile(colony, room, budget))
      .map((room) => new BustCoreMission(colony, room));
  }

  // The invulnerability + collapse-timer worthwhileness gate. With detailed core intel: never dispatch
  // while invulnerable, and skip a core that self-collapses before a buster could arrive AND grind it
  // (pull the remote and wait instead). Skip strongholds (level > 0 — a boosted-squad job, out of scope).
  // Without detailed intel (only the reservation proxy fired), dispatch and let the buster confirm live.
  static worthwhile(colony, room, budget) {
    const core = Threat.invaderCore(room);
    if (!core) return true; // reservation proxy only (an L0 reservation core) — confirm on arrival
    if (core.level > 0) return false; // a stronghold (towers + boosted defenders) — out of scope
    if (core.invulnerableUntil && Game.time < core.invulnerableUntil) return false;
    if (core.collapseAt) {
      const dps = Math.max(1, antiCoreBody(budget).filter((p) => p === ATTACK).length * ATTACK_POWER);
      const arriveAndGrind = this.travelTicks(colony, room) + core.hits / dps;
      if (core.collapseAt - Game.time < arriveAndGrind) return false; // dies on its own first
    }
    return true;
  }

  // Rough travel time home → room (hops × tiles/room), for the collapse-timer gate. No known safe corridor
  // → fall back to the linear room distance (conservative; don't optimistically assume 1 hop and green-light
  // a core that self-collapses before a buster could actually arrive). The buster's own routeToRoom handles
  // a path that turns out truly blocked.
  static travelTicks(colony, room) {
    const route = towerFreeRoute(colony.name, room);
    const hops = route ? route.length : Game.map.getRoomLinearDistance(colony.name, room) + 1;
    return hops * TILES_PER_ROOM;
  }

  constructor(colony, room) {
    this.colony = colony;
    this.room = room;
    this.type = "bust-core";
  }

  // Stable per-mission identity (type + target room) — stamped on each member's memory.mission so the
  // overlord groups members by mission and counts coverage per mission, not globally.
  get key() {
    return `${this.type}:${this.room}`;
  }

  // The ROSTER: the GROUP to field as unit-types × counts. One cheap pure-ATTACK buster (count 1; the
  // spine fields any count — "two halve it" — left at 1 for an L0 core). Each slot carries the behaviour
  // set stamped on its creeps: the bustCore conduct, with selfDefense riding alongside for en-route
  // survival. An unaffordable budget yields an empty body → the overlord skips the slot (never a worker).
  roster() {
    return [
      {
        body: antiCoreBody(this.colony.spawnEnergyBudget()),
        count: 1,
        behaviors: { default: "bustCore", nodes: ["selfDefense"] },
      },
    ];
  }

  // Total creeps the full group needs — the muster target.
  size() {
    return this.roster().reduce((n, slot) => n + slot.count, 0);
  }

  // REMOTE replacement policy: spawning is open only while the group is still home (no member has launched
  // yet) — losses are refilled cheaply during muster. Once committed (any member launched), casualties are
  // NOT replaced; a wipe is re-emitted by the recogniser on the next visit, never trickled into a fight.
  canSpawn(members) {
    return !members.some((c) => c.memory.launched);
  }

  // Drive the group's stage machine each tick (the mission OWNS its lifecycle). MUSTER at home until the
  // full roster is spawned and ready (rallied), then LAUNCH and steer the group to the remote. `launched`
  // latches on the creep (model state) so a later loss never yanks survivors back to rally. Home defence
  // preempts — a unit sits home while home is hot. The bustCore behaviour reads memory.target and runs the
  // transit → grind → garrison conduct from there.
  drive(members) {
    const home = this.colony.name;
    const rallied = members.filter((c) => !c.spawning).length >= this.size();
    for (const creep of members) {
      if (rallied) creep.memory.launched = true;
      const advance = creep.memory.launched && !Threat.isHot(home);
      creep.memory.target = advance ? this.room : home;
    }
  }
}
