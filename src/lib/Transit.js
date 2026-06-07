import { Threat } from "./Threat.js";
import { routeRoomBlocked, towerFreeRoute } from "./Routing.js";
import { Movement } from "./Movement.js";
import { Debug } from "./Debug.js";

// ============================================================================
//  Transit — SK/tower-safe, SWAMP-AWARE cross-room travel for any unit a swamp
//  penalises (#225/#227 economy claim/pioneer; #230 combat guards/hunters/warband).
//
//  The first cut copied the scout: plan a tower-free ROOM corridor once, then walk it
//  leg-by-leg toward each room's CENTRE. That works for a scout — a [MOVE]-only body is
//  swamp-IMMUNE (zero fatigue), so the engine paths it dead straight. But a body bearing
//  ANY non-MOVE part (CLAIM/WORK/ATTACK/RANGED/HEAL) is swamp-PENALISED, so the engine's
//  cheapest tile-path WINDS toward the clean (non-swamp) exits of a room. Targeting each
//  room's centre fought that winding path: where a room had a near SWAMPY exit and a far
//  CLEAN one, the engine wanted the far exit while the leg-walk dragged the creep back
//  toward the centre/near exit — and it YO-YO'd on the border for 30+ ticks, never
//  progressing (live, and it got killed there). The combat behaviors had their own
//  leg-by-leg mover with the identical flaw (#230) — unified here.
//
//  Fix: don't fight the engine. Let it compute the WHOLE swamp-aware multi-room path in ONE
//  travelTo and COMMIT to it (the project's foreign-room travelTo uses reusePath, so the path
//  is followed tile-by-tile, not re-decided each tick → it can't yo-yo). Safety (never path
//  through Source-Keeper / hostile-towered / unwinnable-hot rooms) is preserved by BLOCKING
//  those rooms in the pathfinder's room callback — so the engine does free swamp-aware TILE
//  pathing only WITHIN the safe room set, and naturally takes the clean far exits.
//
//  Two policies on one mover (the only axes economy and combat differ on):
//   • `clearer` — a COMBAT unit passes itself, so a WINNABLE hot room stays passable (it clears
//     it in passing rather than detouring, denying along the way) while SK/towered/unwinnable
//     rooms stay blocked. Economy passes none → all hot rooms are routed around. With a clearer
//     we also probe corridor EXISTENCE (a room-level findRoute) so a boxed-in combat unit can
//     fall back to fighting instead of freezing at a sealed border — travelTo is purely
//     side-effectful (no ERR_NO_PATH return) so it can't report "no path" on its own.
//   • `allowUnscouted` — economy (default true) may probe the dark toward a known target; combat
//     (false) never transits BLIND through an unknown room that could hide a tower.
//
//  On damage in economy mode, bump the room's scoutThreat so the ScoutOverlord hunter clears a
//  persistent blocker and re-opens the route for the next fragile unit (#147/#187) — cheaper than
//  escorting a CLAIM body. A combat unit IS that responder, so it re-routes itself (no bump).
// ============================================================================

// Drive `creep` toward `destRoom`, letting the engine path swamp-aware within SK/tower/hot-safe rooms.
// Returns true while travelling; false once IN destRoom OR (combat mode) when no safe corridor exists —
// the caller disambiguates via `creep.room.name === destRoom` (arrived vs trapped) and does its in-room
// approach or its boxed-in fallback (fight here / hold / re-route) accordingly.
export function routeToRoom(creep, destRoom, { range = 20, allowUnscouted = true, clearer = null } = {}) {
  // Casualty signal — economy only: a fragile claimer/pioneer that takes damage can't fight back, so it
  // bumps this room's scoutThreat for the hunter to clear the blocker and let the next unit through (same
  // signal scouts raise). A combat unit (clearer) IS that responder and re-routes itself — a self-summon
  // would be circular, so it skips the bump.
  if (!clearer && creep.hits < (creep.memory.lastHits ?? creep.hitsMax)) {
    Threat.bumpScoutThreat(creep.room.name);
  }
  creep.memory.lastHits = creep.hits;

  if (creep.room.name === destRoom) {
    // Arrival event boundary (#215) — fires once on arrival, gated on the en-route flag set while
    // travelling, then cleared so it won't re-fire while the caller sits in the destination.
    if (creep.memory._enroute) {
      Debug.for(creep.memory.role, creep.name).event(() => ({ ev: "arrived", room: destRoom }));
      delete creep.memory._enroute;
    }
    return false; // arrived — caller takes over the in-room approach
  }

  // Combat (clearer) mode: a unit that must FIGHT when boxed in needs to know a safe corridor still
  // exists. travelTo is purely side-effectful (it returns no ERR_NO_PATH), so probe corridor existence
  // with a room-level findRoute and signal "trapped" (false) when none — the caller engages locally
  // rather than freeze at a sealed border. Economy callers pass no clearer and skip this probe: a
  // claimer simply keeps trying (its prior behaviour, unchanged — no extra findRoute on the economy path).
  if (clearer && !towerFreeRoute(creep.room.name, destRoom, { allowUnscouted, avoidHot: true, clearer })) {
    delete creep.memory._enroute;
    return false; // no safe corridor — trapped; caller's fallback handles it
  }

  creep.memory._enroute = true;
  creep.travelTo(new RoomPosition(25, 25, destRoom), {
    range,
    // We supply the cost callback ourselves (SK/danger), so don't let travelTo overwrite it with the
    // plain danger overlay (it only sets that when avoidHostiles resolves truthy).
    avoidHostiles: false,
    pathOpts: {
      // Block the rooms towerFreeRoute would (Source-Keeper by coordinate, hostile-towered, unwinnable-hot)
      // as a PathFinder ROOM block — so the engine paths swamp-aware at the TILE level only within the safe
      // set (and uses the clean far exit a swamp-penalised unit needs). A winnable-hot room is left passable
      // for a clearer. The destination is never blocked; everything else keeps the in-room hostile kill-zone
      // overlay. allowUnscouted lets the dark stay passable for economy probing.
      costCallback: (roomName, matrix) =>
        roomName !== destRoom && routeRoomBlocked(roomName, { allowUnscouted, clearer })
          ? false
          : Movement.dangerCallback(roomName, matrix),
    },
  });
  return true;
}
