import { Threat } from "./Threat.js";
import { routeRoomBlocked } from "./Routing.js";
import { Movement } from "./Movement.js";

// ============================================================================
//  Transit — SK/tower-safe, SWAMP-AWARE cross-room travel for vulnerable (non-combat)
//  units like the Claimer/Pioneer (#225).
//
//  The first cut copied the scout: plan a tower-free ROOM corridor once, then walk it
//  leg-by-leg toward each room's CENTRE. That works for a scout — a [MOVE]-only body is
//  swamp-IMMUNE (zero fatigue), so the engine paths it dead straight. But a CLAIM/WORK-
//  bearing unit is swamp-PENALISED, so the engine's cheapest tile-path WINDS toward the
//  clean (non-swamp) exits of a room. Targeting each room's centre fought that winding
//  path: where a room had a near SWAMPY exit and a far CLEAN one, the engine wanted the
//  far exit while the leg-walk dragged the creep back toward the centre/near exit — and it
//  YO-YO'd on the border for 30+ ticks, never progressing (live, and it got killed there).
//
//  Fix: don't fight the engine. Let it compute the WHOLE swamp-aware multi-room path in ONE
//  travelTo and COMMIT to it (the project's foreign-room travelTo uses reusePath, so the path
//  is followed tile-by-tile, not re-decided each tick → it can't yo-yo). Safety (towerFreeRoute's
//  job: never path through Source-Keeper / hostile-towered / unwinnable-hot rooms) is preserved
//  by BLOCKING those rooms in the pathfinder's room callback — so the engine does free swamp-aware
//  TILE pathing only WITHIN the safe room set, and naturally takes the clean far exits. On damage,
//  bump the room's scoutThreat so the ScoutOverlord hunter clears a persistent blocker and re-opens
//  the route for the next unit (#147/#187) — cheaper than escorting or arming a fragile CLAIM body.
//
//  Tower/SK-free vs Game.map.findRoute: blocking the room in the cost callback is still fully tower/SK-
//  safe (the engine never ENTERS a blocked room — it routes AROUND it), but it's a TILE search bounded
//  to the engine's ~16-room horizon, not findRoute's whole-map room graph. Ample for our hop counts; the
//  only gap is a tower whose detour exceeds that horizon. We deliberately do NOT lock the path to a
//  towerFreeRoute corridor: the swamp detours must be free to dip into adjacent rooms for clean exits,
//  and a strict corridor would re-break exactly that. If a far target ever needs a guaranteed long tower
//  detour, widen this to a "safe REGION" (the towerFreeRoute corridor PLUS a margin of neighbours) as the
//  allowed set — keeps the swamp freedom and restores the whole-map guarantee.
// ============================================================================

// Drive `creep` toward `destRoom`, letting the engine path swamp-aware within SK/tower/hot-safe rooms.
// Returns true while travelling, false once IN destRoom (the caller does the precise in-room approach).
export function routeToRoom(creep, destRoom, { range = 20 } = {}) {
  // Casualty signal: took damage since last tick → a (maybe persistent) blocker is on the route. Bump
  // this room's scoutThreat so the hunter clears it and the next unit gets through (same signal scouts raise).
  if (creep.hits < (creep.memory.lastHits ?? creep.hitsMax)) {
    Threat.bumpScoutThreat(creep.room.name);
  }
  creep.memory.lastHits = creep.hits;

  if (creep.room.name === destRoom) return false; // arrived — caller takes over the in-room approach

  creep.travelTo(new RoomPosition(25, 25, destRoom), {
    range,
    // We supply the cost callback ourselves (SK/danger), so don't let travelTo overwrite it with the
    // plain danger overlay (it only sets that when avoidHostiles resolves truthy).
    avoidHostiles: false,
    pathOpts: {
      // Block the rooms towerFreeRoute would (Source-Keeper by coordinate, hostile-towered, unwinnable-hot)
      // as a PathFinder ROOM block — so the engine paths swamp-aware at the TILE level only within the safe
      // set (and uses the clean far exit a swamp-penalised unit needs). The destination is never blocked.
      // Everything else keeps the in-room hostile kill-zone overlay. allowUnscouted: probing the dark is fine.
      costCallback: (roomName, matrix) =>
        roomName !== destRoom && routeRoomBlocked(roomName, { allowUnscouted: true })
          ? false
          : Movement.dangerCallback(roomName, matrix),
    },
  });
  return true;
}
