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
