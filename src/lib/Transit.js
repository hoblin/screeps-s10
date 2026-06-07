import { towerFreeRoute } from "./Routing.js";
import { Threat } from "./Threat.js";

// ============================================================================
//  Transit — stable, SK-safe cross-room travel for VULNERABLE (non-combat) units
//  (#225). The scout's proven pattern, lifted for reuse by the expansion roles.
//
//  travelToRoom (the combat atom) re-runs findRoute every tick and YO-YOS at a
//  border when the route cost field disagrees across a hot-zone ridge (the #213
//  residual — a claimer bounced one border for 30+ ticks, made zero progress, and
//  was killed). Scouts never hit that: they plan a tower-free corridor ONCE and walk
//  it leg-by-leg with plain travelTo(roomCentre, range 20), advancing only on
//  arrival — the engine's reusePath caches the multi-room path and the generous range
//  "arrives" the instant the border is crossed, so there is no per-tick re-evaluation
//  to flip. routeToRoom packages exactly that:
//
//   • Plan the corridor ONCE via towerFreeRoute (scout variant: allowUnscouted, NO
//     clearer/avoidHot — a claimer can't fight, so it routes around KNOWN TOWERS and
//     Source-Keeper rooms (RoomType, inside safeRouteCost) and walks everything else
//     DIRECTLY). Re-plan only when shoved OFF the committed corridor or the destination
//     changes — NEVER per tick (that re-validation is exactly what yo-yos).
//   • Walk leg-by-leg to the next ADJACENT vetted room. travelTo itself is SK-blind, but
//     each leg is to an adjacent non-SK room, so the engine's path never enters keeper
//     space — the safety lives entirely in the pre-planned corridor.
//   • On damage, bump the room's scoutThreat — the SAME casualty signal scouts raise, so
//     the existing ScoutOverlord hunter is dispatched to clear a persistent blocker and
//     re-open the route for the next unit (#147/#187). Cheaper than escorting or arming an
//     expensive CLAIM body: we accept the odd loss and let the clearer handle real
//     blockers (the home economy is healthy enough to spend a few claimers — Женя).
// ============================================================================

// How long a TRAPPED unit (no tower-free corridor exists right now) holds before re-probing,
// so it doesn't re-run Game.map.findRoute every tick — the per-tick churn this helper avoids.
// Intel may reopen a path within the window (a tower decays out of intel, a blocker is cleared).
const ROUTE_RETRY_BACKOFF = 25;

// Drive `creep` toward `destRoom` along a committed tower-free corridor, walked leg-by-leg.
// Returns true while still travelling, false once IN destRoom (the caller does the precise
// in-room approach) OR when no safe corridor exists (a trapped unit — the caller's fallback).
export function routeToRoom(creep, destRoom, { range = 20 } = {}) {
  // Casualty signal: took damage since last tick → a (maybe persistent) blocker sits on the
  // route. Bump this room's scoutThreat so the ScoutOverlord hunter clears it and the next
  // unit walks through (the same signal Scout.enterFlee raises). Cheap and role-agnostic.
  if (creep.hits < (creep.memory.lastHits ?? creep.hitsMax)) {
    Threat.bumpScoutThreat(creep.room.name);
  }
  creep.memory.lastHits = creep.hits;

  if (creep.room.name === destRoom) {
    delete creep.memory._route; // arrived — caller takes over the in-room approach
    return false;
  }

  const m = creep.memory;
  const plan = m._route;
  // Our position along a still-valid committed corridor (same dest, current room on it).
  const idx = plan && plan.dest === destRoom ? plan.rooms.indexOf(creep.room.name) : -1;
  let next = idx >= 0 ? plan.rooms[idx + 1] : null;
  if (!next) {
    // No committed corridor, destination changed, or we were shoved off it → (re)plan ONCE.
    // But hold off if we just failed: a trapped unit must not re-run findRoute every tick.
    if (m._routeRetry && Game.time < m._routeRetry) return false;
    // Scout variant: allowUnscouted (probing the unscouted is fine), no avoidHot/clearer —
    // route around known towers + SK only, walk everything else directly.
    const route = towerFreeRoute(creep.room.name, destRoom, { allowUnscouted: true });
    if (!route) {
      delete m._route;
      m._routeRetry = Game.time + ROUTE_RETRY_BACKOFF; // trapped — re-probe later, not every tick
      return false; // no tower-free corridor exists; caller decides (idle / recycle)
    }
    delete m._routeRetry;
    m._route = { dest: destRoom, rooms: [creep.room.name, ...route.map((r) => r.room)] };
    next = m._route.rooms[1] || destRoom;
  }
  creep.travelTo(new RoomPosition(25, 25, next), { range });
  return true;
}
