// ============================================================================
//  Build-target assignment (#239/#242) — the command-pattern policy shared by every overlord that
//  concentrates a builder fleet on construction sites: WorkOverlord over its home room, ClaimOverlord
//  over a bootstrapping child. The overlord owns site SELECTION; each Build atom only executes the
//  stamped `memory.buildTarget`.
//
//  Split of concerns: the CALLER owns room access — WHICH sites (its home room, or a child room it has
//  vision into) — and passes the resolved creeps + sites in. This module owns only HOW the fleet divides
//  among them, so the exact same concentration policy serves both rooms with no copy-paste.
// ============================================================================

// Stamp each creep's memory.buildTarget across the fleet. Per-trip latch (#86): a creep keeps its site
// while it's still a leader, so there's no per-tick re-pick (the oscillation #86 fixed for haulers).
// Selection ignores creeps (#63), so a creep clustered away from the site is still assigned one
// (travelTo routes it in). Clears stale targets when there's nothing to build.
export function assignBuildTargets(creeps, sites) {
  if (!creeps.length) return;
  if (!sites.length) {
    for (const c of creeps) if (c.memory.buildTarget) c.memory.buildTarget = null;
    return;
  }
  const leaders = buildLeaders(sites);
  const leaderIds = new Set(leaders.map((s) => s.id));
  for (const c of creeps) {
    if (c.memory.buildTarget && leaderIds.has(c.memory.buildTarget)) continue; // latch: still a leader
    const site = c.pos.findClosestByPath(leaders, { ignoreCreeps: true });
    c.memory.buildTarget = site ? site.id : null;
  }
}

// The sites worth building NOW: the most-advanced sites within the highest-priority non-empty tier
// (containers > other structural > roads — #72 containers gate hauling, #14 roads last), with ~10
// build-actions of epsilon slack so a fresh batch (all near 0) stays a flat pool chosen by distance,
// and only a site that pulls a clear lead becomes the magnet the whole fleet converges on (#33).
// SPAWN sites are excluded — they're the top-priority BuildSpawn atom's job (built before everything,
// even filling), and singular, so they need no fleet concentration.
export function buildLeaders(sites) {
  const epsilon = BUILD_POWER * 10;
  const buildable = sites.filter((s) => s.structureType !== STRUCTURE_SPAWN);
  if (!buildable.length) return [];
  const containers = [];
  const structural = [];
  const roads = [];
  for (const s of buildable) {
    if (s.structureType === STRUCTURE_CONTAINER) containers.push(s);
    else if (s.structureType === STRUCTURE_ROAD) roads.push(s);
    else structural.push(s);
  }
  const pool = [containers, structural, roads].find((tier) => tier.length) || buildable;
  const maxProgress = Math.max(...pool.map((s) => s.progress));
  return pool.filter((s) => s.progress >= maxProgress - epsilon);
}
