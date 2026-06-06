// ============================================================================
//  RoomType — classify a room from its NAME alone (#220).
//
//  Screeps lays every 10×10 sector out identically, so a room's danger class is
//  deducible from its coordinates WITHOUT ever seeing it. The central 3×3 of a
//  sector (both coords ending 4–6, minus the very centre) is Source-Keeper space:
//  three fat sources guarded by Keepers that kill anything we can field until a
//  far-future boosted stage. A transiting creep must route AROUND those, never
//  through — so the router needs a vision-free test for them (the offline
//  expansion map already excludes them as remotes via the same static fact).
// ============================================================================

// Parse a room name ("E12S5", "W55S43") into sector-local coordinates (0–9 on
// each axis) — all the keeper-room test needs. Returns null for a name that
// doesn't parse (e.g. "sim"), so callers treat it as a normal room.
function sectorCoords(roomName) {
  const m = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!m) return null;
  return { x: Number(m[1]) % 10, y: Number(m[2]) % 10 };
}

// Is this a Source-Keeper room? The 8 rooms ringing a sector's centre (both axes
// in 4–6) are keeper-guarded; the very centre (5,5) is the sector's special core
// room (no keeper lairs) and is NOT one. Highway rooms (an axis ending in 0) and
// everything else are normal.
export function isSourceKeeperRoom(roomName) {
  const c = sectorCoords(roomName);
  if (!c) return false;
  const inBand = (n) => n >= 4 && n <= 6;
  if (!inBand(c.x) || !inBand(c.y)) return false;
  return !(c.x === 5 && c.y === 5); // centre core room is not keeper space
}
