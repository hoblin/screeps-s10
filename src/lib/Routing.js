import { INTEL_FRESH_TICKS, Threat } from "./Threat.js";
import { isSourceKeeperRoom } from "./RoomType.js";

// ============================================================================
//  Routing — shared multi-room route planning (#194). Extracted from GuardOverlord so
//  both the guard (retaliation) and the scout (transit) avoid hostile towers from ONE
//  source (extract-and-share, not copy-paste).
// ============================================================================

// A multi-room route from→to that routes AROUND danger. Returns the `Game.map.findRoute` array
// ([{exit, room}], the rooms to traverse after `from`), or null if no safe path exists; [] for same room.
//
// Two opt-in axes the callers differ on:
//   • `allowUnscouted` — what an unscouted/stale room means:
//       guards (default false) — never path BLIND into a possible tower; unknown = impassable, so a
//       guard only travels a vetted corridor.
//       scouts (true) — probing the unscouted IS their job, so only FRESH-KNOWN towers close a room;
//       unknown stays passable (a first-probe death is unavoidable and self-correcting — once seen,
//       the tower is recorded and the room closes).
//   • `avoidHot` — also weigh rooms with a live armed threat (Invader/SK/player force, `intel.threat>0`):
//     a hot room we'd die in must be routed around (the #197 "walked blind through an Invader room"
//     failure), BUT a WINNABLE hot room is left PASSABLE — a combat unit clears it in passing rather
//     than detouring, denying along the way (Женя). Pass `clearer` (the transiting creep) so winnability
//     is judged against THAT unit via the shared `Threat.winnableBy`; with no clearer, avoidHot
//     conservatively closes all hot. Towers stay closed unconditionally (a RANGED kiter can't break
//     one — #178 — winnable or not).
// Trust is fresh-only (staleness = decay): a stale entry reverts to "unknown", handled by allowUnscouted.
export function towerFreeRoute(from, to, { allowUnscouted = false, avoidHot = false, clearer = null } = {}) {
  if (from === to) return [];
  const route = Game.map.findRoute(from, to, {
    routeCallback: (roomName) => safeRouteCost(roomName, to, allowUnscouted, avoidHot, clearer),
  });
  return Array.isArray(route) ? route : null; // ERR_NO_PATH → null
}

// Is a single room CLOSED for safe transit right now — towered, or a hot room this `clearer` can't win
// (same policy as the route cost, judged for a non-destination room)? The per-hop freshness check a
// COMMITTED corridor uses: it walks a cached route stably (no per-tick findRoute, #213) but bails to a
// re-route the moment its next hop turns dangerous, so committing never walks blind into a fresh tower /
// unwinnable threat (#197 safety preserved).
export function routeRoomBlocked(roomName, { allowUnscouted = false, clearer = null } = {}) {
  return safeRouteCost(roomName, null, allowUnscouted, true, clearer) === Infinity;
}

// The shared per-room cost for a safe corridor (one source for the route-callback policy). 1 = passable,
// Infinity = closed (findRoute routes around it). The destination is always passable — the caller vets it.
function safeRouteCost(roomName, dest, allowUnscouted, avoidHot, clearer) {
  // Source-Keeper rooms are statically lethal (keepers we can't clear) and known
  // from the room NAME alone — no vision needed, so this closes them regardless of
  // intel freshness or the avoidHot/allowUnscouted axes. Non-destination only: a
  // deliberate SK destination (a future keeper-mining op) stays the caller's vetted
  // choice. This is what routes economy/claim transit AROUND the keeper rooms en
  // route to a 2nd colony (#220) instead of through them (the E12S5 corridor crosses
  // keeper space the BFS-shortest path would otherwise dive into).
  if (roomName !== dest && isSourceKeeperRoom(roomName)) return Infinity;
  const intel = Memory.roomIntel?.[roomName];
  // A missing/invalid tick reads as stale (tick 0), not NaN→fresh — defensive against a legacy/corrupt
  // intel entry that would otherwise be wrongly trusted.
  const stale = !intel || Game.time - (intel.tick || 0) > INTEL_FRESH_TICKS;
  // A known tower closes a room to a RANGED unit (#178). Under avoidHot (a combat unit's own transit)
  // this holds even for the DESTINATION — no mode may route us under a tower. Plain length-use
  // (avoidHot=false, e.g. retaliation TTL estimation) still exempts the caller-vetted destination.
  if (!stale && intel.towers > 0 && (avoidHot || roomName !== dest)) return Infinity;
  if (roomName === dest) return 1; // destination otherwise vetted by the caller (a hot dest is the point)
  if (stale) return allowUnscouted ? 1 : Infinity;
  // Live armed threat: clear it in passing IF the clearer out-guns it (winnable), else route around. Avoiding
  // a beatable fight wastes the chance to deny along the way; walking into an unwinnable one is the #197 death.
  if (avoidHot && intel.threat > 0) return clearer && Threat.winnableBy(clearer, roomName) ? 1 : Infinity;
  return 1;
}
