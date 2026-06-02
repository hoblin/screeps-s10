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
// container that someone must drain.
function hasSourceContainer(colony) {
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
    key: "1:Bootstrap",
    // We're always at least bootstrapping while the room is ours.
    enteredWhen: (_colony) => true,
    provides: ["generic miners", "workers", "upgraders"],
    // Promote once we hit RCL 2 (unlocks extensions + containers) OR a source
    // container already exists.
    readyForNextWhen: (colony) =>
      colony.controller.level >= 2 || hasSourceContainer(colony),
  },
  {
    key: "2:StaticMining",
    enteredWhen: (colony) =>
      colony.controller.level >= 2 ||
      countStructures(colony.room, STRUCTURE_CONTAINER) > 0,
    provides: ["static miners", "source containers"],
    // Haulers become worthwhile only once a source container is FINISHED (a
    // miner is now dropping energy into it that must be moved). This is the
    // trigger the hauler logic waits on.
    readyForNextWhen: (colony) => hasSourceContainer(colony),
  },
  {
    key: "2b:Hauling",
    enteredWhen: (colony) => hasSourceContainer(colony),
    provides: ["haulers (container -> spawn/extensions/controller)"],
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

// The current stage = the last stage whose entry trigger is satisfied.
export function currentStage(colony) {
  let active = STAGES[0];
  for (const stage of STAGES) {
    if (stage.enteredWhen(colony)) active = stage;
  }
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
