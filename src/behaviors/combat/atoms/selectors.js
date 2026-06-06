import { Threat } from "../../../lib/Threat.js";

// ============================================================================
//  Combat selectors (#189) — the POLICY layer: pure queries that pick a target or
//  anchor from a pre-scanned hostile list. The seam that lets the same execution acts
//  serve different behaviors — each behavior chooses ITS target rule (armed-first,
//  lowest-hits, nearest-of-any) and hands the pick to the shared acts. Callers pass the
//  already-found hostiles so a tick never re-scans the room per atom.
// ============================================================================

// The armed subset (real combat power) — the threat to engage first; the rest are
// harmless stragglers (scouts/reservers) mopped only when nothing armed remains.
export function armedOf(hostiles) {
  return hostiles.filter((h) => Threat.combatPower(h) > 0);
}

// Closest hostile of ANY kind (no armed filter) — area-denial targeting (KillClosest /
// HoldPosition): kill whatever cycles through the zone, harmless or not.
export function nearestHostile(creep, hostiles) {
  return creep.pos.findClosestByRange(hostiles);
}

// The squad's deterministic shared focus: the lowest-hits ARMED hostile, id-tiebroken so
// every member converges on the SAME kill with no coordinator (FocusFire). Null if none armed.
export function lowestHitsArmed(hostiles) {
  const armed = armedOf(hostiles);
  if (!armed.length) return null;
  return armed.sort((a, b) => a.hits - b.hits || (a.id < b.id ? -1 : 1))[0];
}

// The tile to anchor a hold/denial on: the commander's flag point (memory.point), else
// the room controller. Null when neither exists.
export function anchorPoint(creep) {
  const p = creep.memory.point;
  if (p) return new RoomPosition(p.x, p.y, p.roomName);
  const ctrl = creep.room.controller;
  return ctrl ? ctrl.pos : null;
}

// Importance of a hostile structure to RAZE (#199) — higher = hit first. Spawn is handled as its own
// tier (it stops production), so it's not here. Walls/ramparts are excluded entirely (a RANGED body
// can't break them — needs a dismantler, #178).
const RAZE_VALUE = {
  [STRUCTURE_TOWER]: 6, // defence — but a towered target is usually a dismantler's job (#178)
  [STRUCTURE_STORAGE]: 5,
  [STRUCTURE_TERMINAL]: 5,
  [STRUCTURE_LINK]: 4,
  [STRUCTURE_LAB]: 4,
  [STRUCTURE_EXTENSION]: 3,
  [STRUCTURE_CONTAINER]: 2,
  [STRUCTURE_ROAD]: 1,
};

// The offence raid's single ordered target (#199) — attack the FIRST that exists, so an eliminator
// kills production before chasing respawns. Returns a creep OR structure (the shared acts handle both),
// or null when the room is fully clear. Order:
//   1. armed enemy creeps (combatPower>0) — the real threat;
//   2. enemy SPAWN(s) — stop production (the elimination kill: chasing economy while the spawn pumps is
//      the stalemate, so the spawn outranks harmless creeps);
//   3. ordinary/economy enemy creeps — mop the leftovers;
//   4. other hostile structures by RAZE_VALUE (walls/ramparts excluded).
// Structures sitting UNDER a hostile rampart are skipped at every structure tier — a RANGED body hits
// the rampart (which it can't break, #178), not the structure, so targeting them just wastes ticks.
// `hostiles` is the pre-scanned FIND_HOSTILE_CREEPS list; structures are read live (the creep is on-target).
export function priorityTarget(creep, hostiles) {
  const armed = armedOf(hostiles);
  if (armed.length) return creep.pos.findClosestByRange(armed);

  // A structure is attackable only if no hostile rampart shares its tile (else attacks hit the rampart).
  const rampartTiles = new Set(
    creep.room
      .find(FIND_HOSTILE_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_RAMPART })
      .map((r) => r.pos.x * 50 + r.pos.y)
  );
  const exposed = (s) => !rampartTiles.has(s.pos.x * 50 + s.pos.y);

  const spawns = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN && exposed(s),
  });
  if (spawns.length) return creep.pos.findClosestByRange(spawns);

  if (hostiles.length) return creep.pos.findClosestByRange(hostiles);

  const structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => (RAZE_VALUE[s.structureType] ?? 0) > 0 && exposed(s),
  });
  if (!structures.length) return null;
  let bestTier = 0;
  for (const s of structures) bestTier = Math.max(bestTier, RAZE_VALUE[s.structureType]);
  const top = structures.filter((s) => RAZE_VALUE[s.structureType] === bestTier);
  return creep.pos.findClosestByRange(top);
}
