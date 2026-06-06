import { INTEL_FRESH_TICKS } from "./Threat.js";

// ============================================================================
//  Routing — shared multi-room route planning (#194). Extracted from GuardOverlord so
//  both the guard (retaliation) and the scout (transit) avoid hostile towers from ONE
//  source (extract-and-share, not copy-paste).
// ============================================================================

// A multi-room route from→to that routes AROUND rooms with known hostile towers. Returns the
// `Game.map.findRoute` array ([{exit, room}], the rooms to traverse after `from`), or null if no
// tower-free path exists; [] for same room.
//
// `allowUnscouted` is the one axis the two callers differ on:
//   • guards (default false) — never path BLIND into a possible tower; an unscouted/stale room is
//     impassable, so a guard only travels a vetted tower-free corridor.
//   • scouts (true) — probing the unscouted IS their job, so only rooms with FRESH-KNOWN towers are
//     closed; unknown rooms stay passable (a first-probe death is unavoidable and self-correcting —
//     once seen, the tower is recorded and the room closes).
// Towers are trusted only while intel is fresh (staleness = decay): a stale entry reverts to
// "unknown", handled by the allowUnscouted branch.
export function towerFreeRoute(from, to, { allowUnscouted = false } = {}) {
  if (from === to) return [];
  const route = Game.map.findRoute(from, to, {
    routeCallback: (roomName) => {
      if (roomName === to) return 1; // destination is vetted by the caller
      const intel = Memory.roomIntel?.[roomName];
      if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return allowUnscouted ? 1 : Infinity;
      return intel.towers > 0 ? Infinity : 1; // known tower → avoid
    },
  });
  return Array.isArray(route) ? route : null; // ERR_NO_PATH → null
}
