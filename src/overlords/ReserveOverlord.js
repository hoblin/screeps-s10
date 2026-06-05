import { Overlord } from "./Overlord.js";
import { Reserver } from "../roles/Reserver.js";
import { Threat } from "../lib/Threat.js";

// ============================================================================
//  ReserveOverlord — owns the whole remote-reservation domain (#18 C1, #102).
//
//  ONE controller for ALL remote rooms (not one-per-room): like RemoteMiningOverlord
//  it's a stateless controller over its domain, and a room's identity/threat is the
//  model (the static map + intel overlay). It keeps one reserver on each safe remote
//  room that we mine, re-homing or pulling back reservers as rooms go hot — one
//  owner, full visibility, no per-room coordination.
//
//  Reserving (NOT claiming — zero GCL cost) boosts a room's sources from 1500/300 to
//  3000/300. A room needs a single reserver no matter how many of its sources we tap,
//  so the domain is keyed by ROOM. Health-gated on expansionReady (#89), which
//  self-throttles the whole expansion. The map already excluded SK/enemy rooms.
// ============================================================================
export class ReserveOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // singleton: priority after the home economy
  }

  get role() {
    return "reserver";
  }

  // Distinct remote rooms we mine that aren't contested right now — one reserver each.
  // Carries each room's controller tile (the model the reserver needs to navigate).
  safeRooms() {
    const byRoom = new Map();
    for (const s of this.colony.remoteSources()) {
      if (Threat.isHotForEconomy(s.room)) continue;
      if (!byRoom.has(s.room)) byRoom.set(s.room, { room: s.room, controller: s.controller });
    }
    return [...byRoom.values()];
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    return this.safeRooms().length;
  }

  bodyFor(energyBudget) {
    return Reserver.bodyFor(energyBudget);
  }

  // Stamp the room a new reserver should take: a safe mined room no reserver covers.
  generateSpawnRequest() {
    const req = super.generateSpawnRequest();
    if (!req) return null;
    const covered = this.coveredRooms();
    const r = this.safeRooms().find((room) => !covered.has(room.room));
    if (!r) return null;
    req.memory.reserveRoom = { room: r.room, controller: r.controller };
    return req;
  }

  coveredRooms() {
    return new Set(
      this.assignedCreeps.map((c) => c.memory.reserveRoom?.room).filter(Boolean)
    );
  }

  // Reconcile before driving (same domain-reroute as RemoteMiningOverlord, per room):
  // re-home a reserver off a hot room onto a free safe room; keep a hot-but-on-map
  // assignment (the role holds home until it cools); clear an off-map assignment so
  // the role recycles it.
  run() {
    const safe = this.safeRooms();
    const safeNames = new Set(safe.map((r) => r.room));
    const mapNames = new Set(this.colony.remoteSources().map((s) => s.room));
    const covered = new Set(
      this.assignedCreeps
        .map((c) => c.memory.reserveRoom?.room)
        .filter((name) => name && safeNames.has(name))
    );
    for (const creep of this.assignedCreeps) {
      const name = creep.memory.reserveRoom?.room;
      if (name && safeNames.has(name)) continue;
      const free = safe.find((r) => !covered.has(r.room));
      if (free) {
        creep.memory.reserveRoom = { room: free.room, controller: free.controller };
        covered.add(free.room);
      } else if (!name || !mapNames.has(name)) {
        creep.memory.reserveRoom = null; // orphan/off-map → role recycles it
      }
      // else: hot but on the map, no free room → keep it; the role holds home.
    }
    super.run();
  }

  runCreep(creep) {
    Reserver.run(creep, this.colony);
  }
}
