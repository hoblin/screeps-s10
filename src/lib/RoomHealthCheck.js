// ============================================================================
//  RoomHealthCheck — a per-tick read of the colony's economic DYNAMICS.
//
//  The stage machine (Stages.js) is discrete: it gates WHETHER a capability is
//  on. This is the continuous dial on top: HOW HARD to push within an active
//  stage. It turns observed waste/slack into signals that overlords read in
//  desiredCount() instead of hardcoded constants ("compute counts from game
//  state" — CLAUDE.md).
//
//  It returns SIGNALS/FLAGS, not creep counts — each overlord still owns how
//  many of ITS role to run, derived from these signals (SRP).
//
//  Computed once per tick (Colony caches it on its per-tick instance). The
//  hysteresis latch is persisted in Memory.colonyData[name].health, because the
//  Colony instance is rebuilt every tick and can't remember last tick's value.
//  Same Memory.colonyData pattern the overlords use for cached positions.
// ============================================================================

// `energyRich` is the surplus signal — true when energy is going to waste and we
// should spend it (more builders if there's a backlog, else more upgraders).
// It's a Schmitt trigger (two thresholds) so it doesn't chatter tick-to-tick as
// saturation wobbles: it latches ON at HIGH, OFF at LOW, and holds in between.
//
// Saturation is the terminal waste indicator: when we under-consume, energy
// backs up the whole chain (spawn full -> containers full -> miners overflow)
// and the sources stop being drained, so they sit near cap. One stable signal
// captures "nowhere for energy to go".
const SATURATION_RICH_ON = 0.7; // avg source fill at/above which income is clearly wasted
const SATURATION_RICH_OFF = 0.4; // ...and below which mining has caught up with consumption

export const RoomHealthCheck = {
  compute(colony) {
    const room = colony.room;
    const energyCap = room.energyCapacityAvailable;

    // Average source saturation: high means miners harvest slower than the
    // source regenerates, so the surplus regen burns unused.
    const saturation = colony.sources.length
      ? colony.sources.reduce((sum, s) => sum + s.energy / s.energyCapacity, 0) /
        colony.sources.length
      : 0;

    // Schmitt-triggered surplus latch (hysteresis via Memory — the instance is
    // rebuilt each tick and can't hold last tick's state).
    let energyRich = this.state(colony).energyRich || false;
    if (saturation >= SATURATION_RICH_ON) energyRich = true;
    else if (saturation <= SATURATION_RICH_OFF) energyRich = false;
    this.saveState(colony, { energyRich });

    return {
      // observations
      saturation: Math.round(saturation * 100) / 100,
      spawnFull: energyCap > 0 && room.energyAvailable >= energyCap,
      buildBacklog: room.find(FIND_MY_CONSTRUCTION_SITES).length,
      // the surplus dial overlords read
      energyRich,
      // blocker flags — informational in v1 (surfaced in telemetry for review),
      // future consumers can act on them.
      blockers: {
        extensionsMissing: this.extensionsMissing(colony),
        controllerContainerMissing: this.controllerContainerMissing(colony),
      },
    };
  },

  // A blocker: this RCL unlocks extensions we haven't built, so the spawn energy
  // cap (and thus every body size, incl. the miner's WORK count) is stuck below
  // what the RCL allows — the classic early-game throttle.
  extensionsMissing(colony) {
    const ctrl = colony.controller;
    if (!ctrl) return false;
    const cap = (CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] || {})[ctrl.level] || 0;
    const built = colony.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;
    return built < cap;
  },

  // A blocker: no controller container yet, so upgraders can't park-and-pump and
  // hauled energy has no delivery endpoint near the controller.
  controllerContainerMissing(colony) {
    const ctrl = colony.controller;
    if (!ctrl) return false;
    const near = ctrl.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    });
    return near.length === 0;
  },

  // ---- hysteresis state (cross-tick) — same Memory.colonyData pattern as the
  //      overlords' cached positions --------------------------------------------
  state(colony) {
    return Memory.colonyData?.[colony.name]?.health || {};
  },

  saveState(colony, value) {
    Memory.colonyData ||= {};
    Memory.colonyData[colony.name] ||= {};
    Memory.colonyData[colony.name].health = value;
  },
};
