import { computeLayout } from "./roomLayout.js";
import { log } from "./Logger.js";

// ============================================================================
//  RoomPlanner — the single authority over a colony's structure layout (#258).
//
//  The moment a room becomes ours (controller.my → Stage 0 Founding) this computes
//  the COMPLETE layout for every RCL — every structure, the link/container network,
//  and the road spine — from terrain, ONCE, and caches it to
//  Memory.colonyData[name].roomPlan. Thereafter the per-structure readers (Hatchery,
//  CommandCenter, DefenseOverlord, MiningSite, UpgradeOverlord) just realize their
//  slice of an already-decided board, gated by their stage/RCL/economy trigger.
//
//  One authority owns every tile, so the old 7-independent-planner collisions (a
//  road built on a tower's tile) can't happen. The spatial algorithm itself is the
//  PURE `computeLayout` (src/lib/roomLayout.js) — shared with the offline
//  bin/plan-map.mjs verifier — so this file is only the thin live wrapper: gather
//  inputs from the game, cache, and hand RoomPositions back to the readers.
// ============================================================================

// Bump to force every colony to recompute its plan on the next deploy (the layout
// is cached, never recomputed per tick; a version change is the explicit re-plan).
const PLAN_VERSION = 1;

export const RoomPlanner = {
  // The cached layout for this colony, computing + caching it once if absent.
  // Cheap at rest (a single property read once cached), so it's safe to call every
  // tick from the readers. Returns null for a room we can't plan yet (no controller
  // or no sources visible).
  plan(colony) {
    const cached = Memory.colonyData?.[colony.name]?.roomPlan;
    if (cached && cached.version === PLAN_VERSION) return cached;

    const computed = this.compute(colony);
    if (!computed) return null;
    Memory.colonyData ||= {};
    Memory.colonyData[colony.name] ||= {};
    Memory.colonyData[colony.name].roomPlan = computed;
    this.purgeLegacyCaches(colony.name);
    log.info(
      `[${colony.name}] RoomPlanner: layout computed (anchor ${computed.anchor.x},${computed.anchor.y}, ` +
        `${computed.roads.length} roads)`
    );
    return computed;
  },

  // Run the pure core over the live room. Anchor = the manually-placed home spawn if
  // one exists; null for a freshly-claimed expansion room (the core then picks the
  // spawn tile from terrain — that tile is where the founding pioneer builds spawn #1).
  compute(colony) {
    const room = colony.room;
    if (!room.controller || !colony.sources.length) return null;
    const terrain = room.getTerrain();
    const layout = computeLayout({
      terrain: (x, y) => terrain.get(x, y),
      sources: colony.sources.map((s) => ({ x: s.pos.x, y: s.pos.y })),
      controller: { x: room.controller.pos.x, y: room.controller.pos.y },
      mineral: colony.mineral ? { x: colony.mineral.pos.x, y: colony.mineral.pos.y } : null,
      anchor: colony.spawns[0] ? { x: colony.spawns[0].pos.x, y: colony.spawns[0].pos.y } : null,
      controllerStructures: CONTROLLER_STRUCTURES,
    });
    return { version: PLAN_VERSION, ...layout };
  },

  // The planned tiles for a structure type as [{ pos, rcl, ...meta }] in build
  // order (the core emits them priority-first). The readers filter by rcl and cap.
  tilesFor(colony, structureType) {
    const plan = this.plan(colony);
    const list = plan?.structures?.[structureType] || [];
    return list.map((e) => ({ ...e, pos: new RoomPosition(e.x, e.y, colony.name) }));
  },

  // The planned road tiles as [{ pos, rcl }].
  roads(colony) {
    const plan = this.plan(colony);
    return (plan?.roads || []).map((e) => ({ ...e, pos: new RoomPosition(e.x, e.y, colony.name) }));
  },

  // The base anchor (spawn slot 0) as a RoomPosition, or null before the plan exists.
  anchorPos(colony) {
    const plan = this.plan(colony);
    return plan ? new RoomPosition(plan.anchor.x, plan.anchor.y, colony.name) : null;
  },

  // The single planned tile for a role-tagged structure (containers/links carry a
  // `role`), or null. Used by UpgradeOverlord / the link readers.
  tileForRole(colony, structureType, role) {
    const entry = (this.plan(colony)?.structures?.[structureType] || []).find((e) => e.role === role);
    return entry ? new RoomPosition(entry.x, entry.y, colony.name) : null;
  },

  // The planned container tile adjacent to `targetPos` (a source or the mineral),
  // or null. ID-free (the pure core tags source containers by index, not id), so
  // MiningSite resolves its target's container by adjacency instead of role.
  containerTileFor(colony, targetPos) {
    const entry = (this.plan(colony)?.structures?.[STRUCTURE_CONTAINER] || []).find(
      (e) => Math.max(Math.abs(e.x - targetPos.x), Math.abs(e.y - targetPos.y)) <= 1
    );
    return entry ? new RoomPosition(entry.x, entry.y, colony.name) : null;
  },

  // Drop the cached plan so the next plan() recomputes from scratch — an EXPLICIT
  // re-plan only (e.g. a manual console call); never invoked per tick.
  invalidate(colony) {
    if (Memory.colonyData?.[colony.name]) delete Memory.colonyData[colony.name].roomPlan;
  },

  // One-time self-heal: the unified plan supersedes the 7 old per-planner caches, so
  // delete those orphaned keys the moment a colony gets its plan (no backward-compat
  // obligation — #258). `miningPos` is NOT here: MiningSite still owns it (the plan
  // seeds the {x,y}, the overlord layers the JIT `dist` on top).
  purgeLegacyCaches(name) {
    const data = Memory.colonyData?.[name];
    if (!data) return;
    for (const key of ["extensionPositions", "towerPositions", "storagePosition", "linkPositions", "controllerContainerPos", "roadHeat", "spawnAnchors"]) {
      delete data[key];
    }
  },
};
