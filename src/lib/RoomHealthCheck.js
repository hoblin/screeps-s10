import { hasSourceContainer } from "./Stages.js";
import { RoomLog } from "./RoomLog.js";

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

// Expansion readiness (#89): the home is ready to INVEST in remote mining when its
// spawn has spare capacity — idle spawn time is the currency a remote creep costs.
// We smooth the per-tick idle signal (EWMA) and Schmitt-latch it so it doesn't flap,
// gated off during a home crisis. NOT energyRich: that goes false once logistics
// consumes the surplus (proven live on E15S7), yet spare spawn time can remain. As
// remote mining starts consuming spawn time the ratio falls and the latch releases —
// so expansion self-throttles to available spawn capacity.
const IDLE_ALPHA = 0.05; // EWMA weight for the spawn-idle ratio (~20-tick memory)
const EXPANSION_READY_ON = 0.5; // spawn idle ≥ half the time → spare capacity to invest
const EXPANSION_READY_OFF = 0.2; // ...below this it's busy again → back off (hysteresis)
const DOWNGRADE_CRISIS = 5000; // controller this near downgrade → focus home, don't expand

// Recovery hysteresis (#54): a developed colony whose workforce has collapsed can't
// put energy back into its own spawn (at 2b+ static miners are gated off and self-
// harvest is banned) — a death spiral with no exit. We latch a `recovering` signal
// the Recovery override stage reads, so the colony reverts to self-harvesting
// bootstrap workers until it can sustain specialists again. The enter/exit
// predicates differ (not one threshold), so it never flaps during a normal miner
// respawn gap: ENTER only when nothing can refill the spawn, EXIT only once a worker
// is alive AND the spawn can again afford the static miner 2b will immediately want.

export const RoomHealthCheck = {
  compute(colony) {
    const room = colony.room;
    const energyCap = room.energyCapacityAvailable;
    const prior = this.state(colony); // last tick's latched signals (cross-tick via Memory)

    // Average source saturation: high means miners harvest slower than the
    // source regenerates, so the surplus regen burns unused.
    const saturation = colony.sources.length
      ? colony.sources.reduce((sum, s) => sum + s.energy / s.energyCapacity, 0) /
        colony.sources.length
      : 0;

    // Schmitt-triggered surplus latch (hysteresis via Memory — the instance is
    // rebuilt each tick and can't hold last tick's state).
    let energyRich = prior.energyRich || false;
    if (saturation >= SATURATION_RICH_ON) energyRich = true;
    else if (saturation <= SATURATION_RICH_OFF) energyRich = false;

    const recovering = this.recovering(colony, prior);
    // Story log: only the latch flip (#107) — prior is last tick's persisted value.
    if (!prior.recovering && recovering) RoomLog.record(colony.name, "🆘 recovery on");
    else if (prior.recovering && !recovering) RoomLog.record(colony.name, "✅ recovery off");
    const expansion = this.expansionReadiness(colony, prior, recovering);
    this.saveState(colony, { energyRich, recovering, ...expansion.persist });

    return {
      // observations
      saturation: Math.round(saturation * 100) / 100,
      spawnFull: energyCap > 0 && room.energyAvailable >= energyCap,
      buildBacklog: room.find(FIND_MY_CONSTRUCTION_SITES).length,
      // the surplus dial overlords read
      energyRich,
      // workforce-collapse latch the Recovery override stage reads (#54)
      recovering,
      // the expansion-readiness dial the remote-mining overlord reads (#18/#89)
      expansionReady: expansion.ready,
      spawnIdle: Math.round(expansion.idleRatio * 100) / 100,
      // blocker flags — informational in v1 (surfaced in telemetry for review),
      // future consumers can act on them.
      blockers: {
        extensionsMissing: this.extensionsMissing(colony),
        controllerContainerMissing: this.controllerContainerMissing(colony),
      },
    };
  },

  // Spare-spawn-capacity latch — the expansion-readiness signal (#89). The spawn is
  // "idle" (spare) when none of our spawns is mid-spawn AND energy sits at cap (a
  // busy spawn drains it). We smooth that into a ratio (EWMA) and Schmitt-latch it,
  // gated off during a home crisis — controller decaying, room attacked, or we can't
  // even afford a reserver body. Spawn-idle subsumes "home staffed": an understaffed
  // colony keeps its spawn busy, so the ratio only climbs once targets are met.
  expansionReadiness(colony, prior, recovering) {
    const room = colony.room;
    const idleNow =
      colony.spawns.length > 0 &&
      colony.spawns.every((s) => !s.spawning) &&
      room.energyAvailable >= room.energyCapacityAvailable;
    const idleRatio = (prior.idleRatio ?? 0) * (1 - IDLE_ALPHA) + (idleNow ? 1 : 0) * IDLE_ALPHA;

    const ctrl = colony.controller;
    const decaying = ctrl?.ticksToDowngrade != null && ctrl.ticksToDowngrade < DOWNGRADE_CRISIS;
    const attacked = room.find(FIND_HOSTILE_CREEPS).length > 0;
    const canAffordReserver =
      room.energyCapacityAvailable >= BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];

    let ready = prior.expansionReady || false;
    // Recovery is the ultimate home crisis — never expand while clawing back from a
    // workforce collapse (it would steal the spawn time recovery needs).
    if (decaying || attacked || !canAffordReserver || recovering) ready = false;
    else if (idleRatio >= EXPANSION_READY_ON) ready = true;
    else if (idleRatio <= EXPANSION_READY_OFF) ready = false;

    return { ready, idleRatio, persist: { expansionReady: ready, idleRatio } };
  },

  // Workforce-collapse latch (#54). ENTER when a DEVELOPED colony (past bootstrap —
  // a fresh room legitimately has no creeps, and Stage 1 already self-harvests) has
  // neither a worker nor a miner alive: nothing can refill the spawn. EXIT only once
  // a worker is alive AND the spawn can again afford the static miner 2b will request
  // the instant we leave — exiting any sooner would re-request an unaffordable body
  // and respiral. Latching between the two predicates means a normal miner-respawn
  // gap (workers still alive) never trips it. Spawning creeps count as alive
  // (creepsWithRole includes them), so a worker mid-spawn correctly holds recovery on
  // rather than re-entering.
  recovering(colony, prior) {
    const ctrl = colony.controller;
    const developed = !!ctrl && (ctrl.level >= 2 || hasSourceContainer(colony));
    if (!developed) return false;

    const workerAlive = colony.creepsWithRole("worker").length > 0;
    if (prior.recovering) {
      const minerAffordable = colony.room.energyAvailable >= colony.staticMinerCost();
      return !(workerAlive && minerAffordable); // hold until solidly recovered
    }
    const minerAlive = colony.creepsWithRole("miner").length > 0;
    return !workerAlive && !minerAlive; // nothing can put energy back into the spawn
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
