import { RemoteMission } from "./RemoteMission.js";
import { Threat } from "../lib/Threat.js";
import { antiCoreBody } from "../lib/CombatBody.js";
import { towerFreeRoute } from "../lib/Routing.js";

const TILES_PER_ROOM = 50; // rough tiles/room → travel ticks for the collapse-timer worthwhileness gate

// ============================================================================
//  BustCoreMission (#259) — clear an L0 invader core squatting one of our remotes (it reserves the
//  controller, kicking our reserver and killing mining). A RemoteMission: muster a cheap pure-ATTACK group
//  at home, deploy, grind the core (respecting its invulnerability window), then garrison the controller so
//  a fresh core can't re-seize while the reservation decays back to us. An L0 core has 100k HP, NO tower,
//  NO defenders — nothing fires back — so the body is pure ATTACK (no kite, no heal); the CONDUCT lives in
//  the bustCore behaviour, this class only composes + recognises. The lifecycle is inherited from
//  RemoteMission; only roster() and the worthwhileness gate are bust-core-specific.
// ============================================================================
export class BustCoreMission extends RemoteMission {
  // AUTONOMOUS recogniser: one mission per remote of OURS seized by a core and worth busting. Recognition
  // is co-located with the mission so each TYPE owns "where do I apply"; the overlord only aggregates.
  static autoMissions(colony) {
    // No remote ops while the home economy has collapsed: a recovering colony can't mine the remote a
    // busted core would re-open, and the spawn is needed to claw the home back out (#282). Home defence
    // stays ungated; only the remote tier waits for recovery to clear.
    if (colony.health.recovering) return [];
    const budget = colony.spawnEnergyBudget();
    const rooms = [...new Set(colony.remoteSources().map((s) => s.room))];
    return rooms
      .filter((room) => Threat.coreSeized(room) && this.worthwhile(colony, room, budget))
      .map((room) => new BustCoreMission(colony, room));
  }

  // The invulnerability + collapse-timer worthwhileness gate. With detailed core intel: never dispatch
  // while invulnerable, and skip a core that self-collapses before a buster could arrive AND grind it
  // (pull the remote and wait). Skip strongholds (level > 0 — a boosted-squad job, out of scope). Without
  // detailed intel (only the reservation proxy fired), dispatch and let the buster confirm live on arrival.
  static worthwhile(colony, room, budget) {
    const core = Threat.invaderCore(room);
    if (!core) return true; // reservation proxy only (an L0 reservation core) — confirm on arrival
    if (core.level > 0) return false; // a stronghold (towers + boosted defenders) — out of scope
    if (core.invulnerableUntil && Game.time < core.invulnerableUntil) return false;
    if (core.collapseAt) {
      const dps = Math.max(1, antiCoreBody(budget).filter((p) => p === ATTACK).length * ATTACK_POWER);
      const arriveAndGrind = this.travelTicks(colony, room) + Math.ceil(core.hits / dps); // ceil: grind is whole ticks, keep the gate conservative
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
    super(colony, room);
    this.type = "bust-core";
  }

  // One cheap pure-ATTACK buster (count 1; the spine fields any count — "two halve it" — left at 1 for an
  // L0 core). bustCore conduct, with selfDefense riding alongside for en-route survival. An unaffordable
  // budget yields an empty body → the overlord skips the slot (never a worker fallback).
  roster() {
    return [
      {
        body: antiCoreBody(this.colony.spawnEnergyBudget()),
        count: 1,
        behaviors: { default: "bustCore", nodes: ["selfDefense"] },
      },
    ];
  }
}
