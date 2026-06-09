// ============================================================================
//  Stages — the colony's development roadmap as a formal state machine.
//
//  Philosophy (from Yevhenii, the "think in stages" insight):
//  -----------------------------------------------------------------------------
//  Don't ask "what does the colony need RIGHT NOW?" — react late and you're
//  always firefighting. Instead, model the colony's growth as an ordered list of
//  stages, each with:
//
//    enteredWhen(colony)  -> are we IN this stage? (the entry trigger)
//    provides             -> what capabilities this stage turns on (docs + intent)
//    readyForNextWhen()   -> the trigger that will promote us to the next stage
//
//  Because every stage declares its OWN entry trigger, the "current stage" is
//  simply the LAST stage in the list whose enteredWhen() is true. Knowing the
//  next stage and its trigger lets us PREPARE its logic in advance — the hauler
//  code exists and waits, then activates the instant its trigger fires. The
//  colony walks its own roadmap instead of stumbling into each phase.
//
//  This is the single source of truth for "what stage are we in" — Dashboard,
//  Colony, and Overlords all read from here so telemetry, planning, and
//  behaviour never drift apart.
// ============================================================================

// Small structure helpers (count owned/all structures of a type in a room).
function countMyStructures(room, structureType) {
  return room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === structureType,
  }).length;
}

function countStructures(room, structureType) {
  return room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === structureType,
  }).length;
}

// Is there a finished container sitting adjacent to any source? This is the
// trigger that makes haulers worthwhile: a static miner is now filling a
// container that someone must drain. Exported so RoomHealthCheck can reuse the
// same "developed colony" primitive without re-deriving it (the recovery signal
// must NOT fire on a fresh room that legitimately has no creeps yet).
export function hasSourceContainer(colony) {
  return colony.sources.some((source) => {
    const nearby = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    });
    return nearby.length > 0;
  });
}

// ----------------------------------------------------------------------------
//  The roadmap. Order matters: stages are listed from earliest to latest, and
//  the current stage is the LAST one whose `enteredWhen` is satisfied.
// ----------------------------------------------------------------------------
export const STAGES = [
  {
    // Stage 0 — Founding (#228) is an OVERRIDE stage, like Recovery: a colony with NO spawn yet
    // (a freshly-CLAIMED 2nd colony — its first spawn must be BUILT, unlike the home colony's
    // manually-placed one — or any colony that lost its last spawn) preempts the whole RCL-derived
    // progression. It MUST be an override: a non-override Founding could be leap-frogged by a later
    // stage whose trigger is RCL/container-based, not spawn-based (e.g. pioneers upgrade the controller
    // to RCL 2 before the spawn is built → 2:StaticMining's trigger fires while still spawnless), and
    // `stageAtLeast("1:Bootstrap")` would wrongly read true with no spawn. As an override, `spawns
    // .length === 0` forces the machine to the bottom regardless of RCL, so that predicate reliably
    // means "has a spawn". The only job here: stand up the first spawn — the Hatchery places its site
    // at the RoomPlanner's anchor tile (#258), pioneers from the main colony build it; everything else
    // (containers, miners) gates off until a spawn exists. Checked BEFORE Recovery: no spawn is the more
    // fundamental crisis (you can't refill a spawn that doesn't exist), so a spawnless room founds rather
    // than "recovers".
    key: "0:Founding",
    override: true,
    enteredWhen: (colony) => colony.spawns.length === 0,
    provides: ["first spawn construction site (RoomPlanner anchor) + pioneers build it"],
    // Cosmetic (the override latch controls it); we leave the instant the first spawn stands.
    readyForNextWhen: (colony) => colony.spawns.length > 0,
  },
  {
    // Recovery is an OVERRIDE stage (#54): it is not part of the forward
    // progression — when its trigger fires it preempts whatever RCL-derived stage
    // we'd otherwise be in. A developed colony that loses its whole workforce can't
    // refund its own spawn (at 2b+ static miners are gated off and self-harvest is
    // banned), so it spirals to extinction. While `recovering` is latched (see
    // RoomHealthCheck) `currentStage` returns this stage, dropping every
    // `stageAtLeast` gate to the bottom of the machine — which reactivates Stage-1
    // bootstrap behaviour (generic self-harvesting workers refill the spawn) for
    // free, until the colony can sustain specialists again. Below Founding (a
    // workforce collapse only matters once a spawn exists), still below every normal
    // stage so `stageAtLeast(<anything past bootstrap>)` is false throughout recovery.
    key: "Recovery",
    override: true,
    enteredWhen: (colony) => colony.health.recovering,
    provides: ["emergency generic self-harvesting workers (bootstrap)"],
    // Cosmetic only — the latch (not this trigger) controls the override; we leave
    // recovery the moment `recovering` releases, returning to the real RCL stage.
    readyForNextWhen: (colony) => !colony.health.recovering,
  },
  {
    key: "1:Bootstrap",
    // We're always at least bootstrapping while the room is ours AND has a spawn — the spawnless case
    // is the Founding override above, so this stays the plain floor for a spawned colony.
    enteredWhen: (_colony) => true,
    provides: ["generic miners", "workers", "upgraders"],
    // Promote once we hit RCL 2 (unlocks extensions + containers) OR a source
    // container already exists.
    readyForNextWhen: (colony) =>
      colony.controller.level >= 2 || hasSourceContainer(colony),
  },
  {
    key: "2:StaticMining",
    // Mutually exclusive with 2b: we're in static-mining ONLY while no source
    // container is finished yet. The instant one is built we move to 2b. Without
    // the `!hasSourceContainer` guard this stage's trigger would always also be
    // true when 2b's is, so 2:StaticMining could never display as current.
    enteredWhen: (colony) =>
      (colony.controller.level >= 2 ||
        countStructures(colony.room, STRUCTURE_CONTAINER) > 0) &&
      !hasSourceContainer(colony),
    provides: ["static miners", "source containers"],
    // Haulers become worthwhile only once a source container is FINISHED (a
    // miner is now dropping energy into it that must be moved). This is the
    // trigger the hauler logic waits on.
    readyForNextWhen: (colony) => hasSourceContainer(colony),
  },
  {
    key: "2b:Hauling",
    enteredWhen: (colony) => hasSourceContainer(colony),
    provides: [
      "haulers (container -> spawn/extensions/controller)",
      "roads on hot paths (source <-> spawn <-> controller)",
    ],
    // Promote to mid-game once Storage exists (RCL 4) — logistics gets a hub.
    readyForNextWhen: (colony) =>
      colony.controller.level >= 4 ||
      countMyStructures(colony.room, STRUCTURE_STORAGE) > 0,
  },
  {
    key: "3:Storage&Links",
    enteredWhen: (colony) =>
      colony.controller.level >= 4 ||
      countMyStructures(colony.room, STRUCTURE_STORAGE) > 0,
    provides: ["storage buffer", "link network", "remote mining"],
    readyForNextWhen: (colony) => colony.controller.level >= 6,
  },
  {
    key: "4:Industry",
    enteredWhen: (colony) => colony.controller.level >= 6,
    provides: ["extractor", "terminal", "labs/boosts", "2nd spawn"],
    readyForNextWhen: (colony) => colony.controller.level >= 8,
  },
  {
    key: "5:Endgame/Score",
    enteredWhen: (colony) => colony.controller.level >= 8,
    provides: ["score collection fleet", "scouts"],
    readyForNextWhen: (_colony) => false, // final stage
  },
];

// Per-tick memoization: currentStage is called several times per tick (Dashboard
// + every overlord's stageAtLeast). Stage can't change mid-tick, so cache the
// result keyed by colony name + Game.time. Cheap, and keeps CPU flat as overlord
// count grows.
const _stageCache = { tick: -1, byColony: {} };

// The current stage = the last stage whose entry trigger is satisfied.
export function currentStage(colony) {
  if (_stageCache.tick !== Game.time) {
    _stageCache.tick = Game.time;
    _stageCache.byColony = {};
  }
  const cached = _stageCache.byColony[colony.name];
  if (cached) return cached;

  // An override stage (Recovery) preempts the normal progression: when its trigger
  // is live it IS the current stage regardless of RCL. Checked first; if none is
  // active, fall through to the normal "last NON-override stage entered" scan.
  const override = STAGES.find((stage) => stage.override && stage.enteredWhen(colony));
  let active = override;
  if (!active) {
    active = STAGES.find((stage) => !stage.override); // baseline = first normal stage
    for (const stage of STAGES) {
      if (!stage.override && stage.enteredWhen(colony)) active = stage;
    }
  }
  _stageCache.byColony[colony.name] = active;
  return active;
}

// Convenience: just the stage key string (for telemetry).
export function currentStageKey(colony) {
  return currentStage(colony).key;
}

// The stage we're about to enter next (or null if we're at the end), plus
// whether its trigger is already satisfied. Useful for "prepare ahead" logic
// and for telemetry that shows how close we are to the next phase.
export function nextStage(colony) {
  const current = currentStage(colony);
  const index = STAGES.indexOf(current);
  const next = STAGES[index + 1] || null;
  return {
    current,
    next,
    readyForNext: current.readyForNextWhen(colony),
  };
}

// Predicate: is a given capability available at the colony's current stage?
// Lets overlords gate behaviour on stage instead of re-deriving conditions.
//   stageAtLeast(colony, "2b:Hauling") -> true once we're hauling or beyond.
export function stageAtLeast(colony, stageKey) {
  const targetIndex = STAGES.findIndex((s) => s.key === stageKey);
  if (targetIndex < 0) return false;
  const currentIndex = STAGES.indexOf(currentStage(colony));
  return currentIndex >= targetIndex;
}
