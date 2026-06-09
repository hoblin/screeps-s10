import { log } from "./Logger.js";

// ============================================================================
//  StructureRealizer — the shared "keep construction sites alive up to the RCL
//  cap" lifecycle (#258), extracted from the 7 old planners that each copy-pasted
//  it. Now that ONE RoomPlanner decides every tile, every reader does the same
//  mechanical job: take this type's planned tiles (priority-ordered, each tagged
//  with the RCL it unlocks at), and fill the gap between what the cap allows and
//  what already exists — idempotent, waved, capped, log-don't-throw.
//
//  Gating ("is this type unlocked / affordable yet?") stays in the READER — it
//  decides whether to call this at all and with what cap. This is purely the
//  placement mechanics, shared so it can't drift between structure types.
// ============================================================================

// What a structure type may share its tile with. Only a rampart overlaps a normal
// structure; a container additionally tolerates a road/rampart (and an existing
// container, so a memory reset re-adopts it instead of orphaning it). Anything else
// on the tile means "skip it" rather than spam createConstructionSite every tick.
function coexisting(structureType) {
  if (structureType === STRUCTURE_CONTAINER) {
    return new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_CONTAINER]);
  }
  if (structureType === STRUCTURE_ROAD) {
    return new Set([STRUCTURE_RAMPART, STRUCTURE_CONTAINER]);
  }
  return new Set([STRUCTURE_RAMPART]);
}

function occupied(pos, structureType) {
  const coexist = coexisting(structureType);
  return pos.look().some(
    (item) =>
      (item.type === LOOK_STRUCTURES && !coexist.has(item.structure.structureType)) ||
      (item.type === LOOK_CONSTRUCTION_SITES && !coexist.has(item.constructionSite.structureType))
  );
}

function countOf(room, structureType, find) {
  return room.find(find, { filter: (s) => s.structureType === structureType }).length;
}

export const StructureRealizer = {
  // Keep `structureType` sites alive on its planned `tiles` ([{ pos, rcl }], priority
  // order), up to `cap` (the count the current RCL allows). Fills only the gap over
  // what's built + queued, so it's safe to call every tick. Tiles tagged for a higher
  // RCL than we've reached are skipped — the cap usually already excludes them, but the
  // rcl filter makes a count/cap mismatch harmless. `maxPending` bounds how many sites
  // of this type may be QUEUED at once (roads are a long, low-priority backlog placed in
  // waves, not all 60+ at once). Non-OK results are logged, never thrown; a hard cap
  // (global 100-site / RCL gate) breaks the loop so we don't spam.
  ensureSites(room, structureType, tiles, cap, { maxPending = Infinity } = {}) {
    if (cap <= 0) return;
    const level = room.controller.level;
    const built = countOf(room, structureType, FIND_MY_STRUCTURES);
    const queued = countOf(room, structureType, FIND_MY_CONSTRUCTION_SITES);
    let slots = Math.min(cap - built - queued, maxPending - queued);
    if (slots <= 0) return;

    let capHit = false;
    for (const tile of tiles) {
      if (slots <= 0) break;
      if (tile.rcl > level) continue; // not unlocked yet (cap usually already excludes it)
      if (occupied(tile.pos, structureType)) continue;

      const result = room.createConstructionSite(tile.pos, structureType);
      if (result === OK) {
        slots--;
      } else if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        log.warn(`[${room.name}] ${structureType} site failed: ${result}`);
        capHit = true;
        break;
      } else if (result !== ERR_INVALID_TARGET) {
        log.warn(`[${room.name}] ${structureType} site at ${tile.pos} failed: ${result}`);
      }
    }

    // No silent caps: warn when the planned geometry fits FEWER tiles than the RCL
    // cap allows (a winding room couldn't pack them all). Only for capped structures
    // — roads pass a finite maxPending and have no RCL cap, so the comparison is moot.
    if (maxPending === Infinity && !capHit) {
      const eligible = tiles.filter((t) => t.rcl <= level).length;
      if (eligible < cap) {
        log.warn(`[${room.name}] RoomPlanner fit ${eligible} ${structureType} tiles but RCL ${level} allows ${cap}`);
      }
    }
  },
};
