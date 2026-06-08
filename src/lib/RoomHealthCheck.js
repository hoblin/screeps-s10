import { hasSourceContainer } from "./Stages.js";
import { RoomLog } from "./RoomLog.js";
import { Threat } from "./Threat.js";

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

// `energyRich` is the surplus signal — true when energy is backing up and we should spend it (lifts
// the builder cap when there's a backlog; gates the RCL5 link investment). It's a Schmitt trigger (two
// thresholds) so it doesn't chatter as the buffer wobbles: it latches ON at HIGH, OFF at LOW, holds between.
//
// `saturation` is that surplus, measured as the fill of the colony's ACTIVE energy buffer (#253). The
// old measure — average SOURCE fill — went blind under static mining: a static miner keeps its source
// drained BY DESIGN, so the source sits near-empty while the surplus pools DOWNSTREAM. So we read where
// the surplus actually accumulates, mirroring UpgradeOverlord.bufferDelta's buffer selection (see
// bufferSaturation): storage depth if storage exists, else the source CONTAINERS' fill, else (pre-
// container) the raw source fill. One stable 0..1 signal that captures "energy is backing up" in every regime.
const SATURATION_RICH_ON = 0.7; // active-buffer fill at/above which surplus is clearly backing up
const SATURATION_RICH_OFF = 0.4; // ...and below which consumption has caught up with income
// Storage capacity is huge (≥1M), so a raw fill ratio would never cross the thresholds — normalise
// storage DEPTH to this "fully rich" mark instead (energyRich latches ON ≈35k, OFF ≈20k of banked storage).
const STORAGE_RICH_FULL = 50000;

// Spawn-idle EWMA — the smoothed fraction of recent ticks the spawn sat idle. NO LONGER gates
// expansion (#210): tying expansion to spawn-idle was self-defeating — the ScoutOverlord (#170) fills
// every idle cycle with score scouts, so spawn-idle reads ~0 even on a rich colony and strangled the
// remotes. Kept SOLELY for ScoutOverlord's spawn-idle scout term (#170). expansionReady now reads home
// economy health instead (see expansionReadiness).
const IDLE_ALPHA = 0.05; // EWMA weight for the spawn-idle ratio (~20-tick memory)
const DOWNGRADE_CRISIS = 5000; // controller this near downgrade → focus home, don't expand

// Road-build readiness (#135): a road costs ENERGY + worker build-time, NOT spawn
// time, so — unlike expansionReady — its gate ignores spawn-idle and tracks sustained
// energy headroom (spawn+extensions near-topped). Dedicated thresholds, NOT a reuse of
// the expansion ones, so road gating tunes independently (the lesson of one gate reused
// everywhere). Shares IDLE_ALPHA — a generic EWMA memory window, no expansion meaning.
const ROAD_BUILD_READY_ON = 0.5; // near-full ≥ half the time → headroom to build roads
const ROAD_BUILD_READY_OFF = 0.2; // ...below this, hold off (hysteresis)
// "Near-full" tolerance: extensions count as topped at ≥90% of cap. A busy colony's
// spawn debits the body cost the instant it starts, so energyAvailable sits a spawn-
// cost BELOW cap almost every tick (live: ~1260/1300) — a strict ==cap test would
// never latch in exactly the colony this gate targets. 90% reads the SUSTAINED
// headroom through that transient drain. Tunable from live behaviour.
const ROAD_BUILD_FULL_FRAC = 0.9;

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

    // Surplus level: the fill of the colony's ACTIVE energy buffer (#253) — high means consumption is
    // lagging income, so energy is backing up. Reads where the surplus actually pools (see bufferSaturation).
    const saturation = this.bufferSaturation(colony);

    // Schmitt-triggered surplus latch (hysteresis via Memory — the instance is
    // rebuilt each tick and can't hold last tick's state).
    let energyRich = prior.energyRich || false;
    if (saturation >= SATURATION_RICH_ON) energyRich = true;
    else if (saturation <= SATURATION_RICH_OFF) energyRich = false;

    const recovering = this.recovering(colony, prior);
    // Story log: only the latch flip (#107) — prior is last tick's persisted value.
    if (!prior.recovering && recovering) RoomLog.record(colony.name, "🆘 recovery on");
    else if (prior.recovering && !recovering) RoomLog.record(colony.name, "✅ recovery off");
    // Home-crisis flags both readiness latches gate off on — computed ONCE so the
    // hostile scan (Threat.assess) isn't repeated per signal.
    const crisis = this.homeCrisis(colony);
    const idleRatio = this.spawnIdleRatio(colony, prior); // EWMA, for ScoutOverlord #170 — NOT expansion
    const expansionReady = this.expansionReadiness(colony, recovering, crisis); // #210: home-economy health
    const roadBuild = this.roadBuildReadiness(colony, prior, recovering, crisis);
    this.saveState(colony, {
      energyRich,
      recovering,
      idleRatio,
      ...roadBuild.persist,
    });

    return {
      // observations
      saturation: Math.round(saturation * 100) / 100,
      spawnFull: energyCap > 0 && room.energyAvailable >= energyCap,
      buildBacklog: room.find(FIND_MY_CONSTRUCTION_SITES).length,
      // the surplus dial overlords read
      energyRich,
      // workforce-collapse latch the Recovery override stage reads (#54)
      recovering,
      // the expansion-readiness gate the remote overlords read (#18/#210) — home-economy health
      expansionReady,
      spawnIdle: Math.round(idleRatio * 100) / 100,
      // the road-build dial Hatchery.planRoads reads (#135) — energy headroom, not
      // spawn-idle (a road costs energy + worker time, not spawn time)
      roadBuildReady: roadBuild.ready,
      // blocker flags — informational in v1 (surfaced in telemetry for review),
      // future consumers can act on them.
      blockers: {
        extensionsMissing: this.extensionsMissing(colony),
        controllerContainerMissing: this.controllerContainerMissing(colony),
      },
    };
  },

  // The surplus level feeding `saturation`/`energyRich` — the fill of the colony's ACTIVE energy buffer,
  // so it tracks where surplus actually pools under static mining (#253). Mirrors the buffer selection of
  // UpgradeOverlord.bufferDelta:
  //  • STORAGE (RCL4+): its DEPTH normalised to STORAGE_RICH_FULL (a raw ratio would never cross the
  //    thresholds — storage holds ≥1M). Post-storage the source containers are kept drained INTO storage,
  //    so storage depth is the true surplus there.
  //  • SOURCE CONTAINERS (pre-storage): pooled fill (Σenergy / Σcapacity) — the downstream backup a static
  //    miner's overflow lands in. Capacity-pooled so one missing/empty container can't skew the ratio.
  //  • SOURCES (pre-container, early 2a): raw fill — mining isn't static yet, so the source level is still meaningful.
  bufferSaturation(colony) {
    const storage = colony.room.storage;
    if (storage) {
      return Math.min(1, storage.store[RESOURCE_ENERGY] / STORAGE_RICH_FULL);
    }
    const containers = colony.sourceContainers();
    if (containers.length) {
      let energy = 0;
      let capacity = 0;
      for (const c of containers) {
        energy += c.store[RESOURCE_ENERGY];
        capacity += c.store.getCapacity(RESOURCE_ENERGY);
      }
      return capacity ? energy / capacity : 0;
    }
    return colony.sources.length
      ? colony.sources.reduce((sum, s) => sum + s.energy / s.energyCapacity, 0) / colony.sources.length
      : 0;
  },

  // Home-crisis flags both readiness latches gate off on (`{ decaying, attacked }`),
  // computed once per tick so the hostile scan isn't repeated per signal.
  //  • decaying — controller near downgrade: focus home, don't invest.
  //  • attacked — combat-assessed, not a raw hostile count (#120, aligning with #105):
  //    a harmless transiting scout (0 combat power) must NOT suppress investment — only
  //    a genuinely armed attacker in the home room does.
  homeCrisis(colony) {
    const ctrl = colony.controller;
    return {
      decaying: ctrl?.ticksToDowngrade != null && ctrl.ticksToDowngrade < DOWNGRADE_CRISIS,
      attacked: Threat.assess(colony.room) > 0,
    };
  },

  // Spawn-idle EWMA (#170): the smoothed fraction of recent ticks the spawn was idle (no spawn in
  // progress AND energy at cap). Persisted for cross-tick smoothing; consumed by ScoutOverlord to fill
  // spare spawn cycles with score scouts. NOT an expansion signal anymore (#210).
  spawnIdleRatio(colony, prior) {
    const room = colony.room;
    const idleNow =
      colony.spawns.length > 0 &&
      colony.spawns.every((s) => !s.spawning) &&
      room.energyAvailable >= room.energyCapacityAvailable;
    return (prior.idleRatio ?? 0) * (1 - IDLE_ALPHA) + (idleNow ? 1 : 0) * IDLE_ALPHA;
  },

  // expansionReady (#210) — may we START/grow remote expansion? It asks "is the home colony's own
  // economy alive and healthy", NOT "is the spawn idle" (the old spawn-idle gate was gamed by the
  // score-scout fleet, #170, which eats every idle cycle — so it read false on a rich colony and
  // starved the remotes). Ready when home PRODUCTION is staffed (a miner on every home source) AND its
  // OUTPUT is moving (home haulers staffed to the freight DEMAND — Colony.freightHaulers, #272 — not a
  // per-source count the freight model long ago outgrew) AND there's no home crisis AND we can afford the
  // expansion creep. Stateless
  // (no latch) — a structural read, not a noisy ratio. The spawn-priority ladder does the rest: remotes
  // sit below the home economy, so the Hatchery (serves the single top-priority request, waits otherwise)
  // only reaches them once home is satisfied.
  expansionReadiness(colony, recovering, crisis) {
    const room = colony.room;
    const sources = colony.sources.length;
    if (sources === 0) return false;
    const miners = colony.creepsWithRole("miner").filter((c) => !c.spawning).length;
    const minersStaffed = miners >= sources; // a static miner on every home source = the miner demand
    // Output moving: the home haulers are staffed to the room's DEMAND — the freight target the colony sizes
    // its fleet to (#84) — NOT a per-source count, which over-demanded once one big hauler covers several
    // sources and stalled expansion entirely (#272). Single-sourced via Colony.freightHaulers so this gate
    // and LogisticsOverlord can never disagree.
    const haulers = colony.creepsWithRole("hauler").filter((c) => !c.spawning).length;
    const transportOk = haulers >= colony.freightHaulers();
    const canAffordReserver = room.energyCapacityAvailable >= BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];
    return (
      minersStaffed &&
      transportOk &&
      canAffordReserver &&
      !recovering &&
      !crisis.decaying &&
      !crisis.attacked
    );
  },

  // Road-build readiness (#135): may we fund road construction NOW? A road costs
  // energy + worker build-time, not spawn time — so this is deliberately NOT
  // expansionReady. It tracks sustained ENERGY HEADROOM: spawn+extensions sitting
  // NEAR-topped (≥ROAD_BUILD_FULL_FRAC of cap) means the immediate spawn demand is met
  // and the next energy has room to fund a road. The near-full tolerance is the crux:
  // a busy spawn debits its body cost the instant it starts, so energy sits a spawn-
  // cost below cap almost every tick — a strict ==cap test would never latch in exactly
  // the busy colony this gate targets. Same EWMA + Schmitt machinery as
  // expansionReadiness, but the raw signal drops the spawn-idle term (and the reserver-
  // affordability gate — irrelevant to a structure). So roads extend whenever income
  // outpaces the spawn, even while it stays busy — exactly when expansionReady (spawn-
  // idle) wrongly reads false. Crisis-gated like the rest. Road-scoped on purpose:
  // other construction gets its own gate.
  roadBuildReadiness(colony, prior, recovering, crisis) {
    const room = colony.room;
    const fullNow =
      room.energyCapacityAvailable > 0 &&
      room.energyAvailable >= room.energyCapacityAvailable * ROAD_BUILD_FULL_FRAC;
    const fullRatio = (prior.roadFullRatio ?? 0) * (1 - IDLE_ALPHA) + (fullNow ? 1 : 0) * IDLE_ALPHA;

    let ready = prior.roadBuildReady || false;
    if (crisis.decaying || crisis.attacked || recovering) ready = false;
    else if (fullRatio >= ROAD_BUILD_READY_ON) ready = true;
    else if (fullRatio <= ROAD_BUILD_READY_OFF) ready = false;

    return { ready, fullRatio, persist: { roadBuildReady: ready, roadFullRatio: fullRatio } };
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
