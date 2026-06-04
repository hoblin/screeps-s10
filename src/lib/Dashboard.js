// ============================================================================
//  Dashboard — colony status telemetry.
//
//  TWO outputs:
//   1. Memory.status  — structured snapshot written EVERY tick (pull model).
//      Read instantly anytime via the API memory endpoint; no waiting for a
//      console message to happen. This is the primary telemetry channel.
//   2. console.log    — human-readable summary printed every LOG_INTERVAL ticks,
//      for glancing at the in-game UI console.
//
//  Why Memory over console: console is push/streaming — you must be listening
//  the moment a line is emitted. Memory persists between ticks, so a single
//  read always returns the latest snapshot. Pull > push for status.
// ============================================================================
import { log } from "./Logger.js";
import { nextStage } from "./Stages.js";

const LOG_INTERVAL = 30; // ticks between human console summaries

// Stage is now derived from the formal Stages state machine (single source of
// truth shared with Colony/Overlords), not re-inferred here.

const sourceEnergy = (colony) => colony.sources.reduce((a, s) => a + s.energy, 0);

function pct(cur, max) {
  return max ? Math.floor((cur / max) * 100) : 0;
}

export const Dashboard = {
  // Called once per tick by the Kernel.
  run(colonies) {
    const snap = {
      time: Game.time,
      cpu: {
        used: +Game.cpu.getUsed().toFixed(2),
        limit: Game.cpu.limit,
        bucket: Game.cpu.bucket,
      },
      gcl: { level: Game.gcl.level, pct: pct(Game.gcl.progress, Game.gcl.progressTotal) },
      colonies: {},
    };

    for (const name in colonies) {
      try {
        snap.colonies[name] = this.snapshot(colonies[name]);
      } catch (err) {
        log.error(`Dashboard ${name}: ${err.stack || err}`);
      }
    }

    // 1) Write to Memory every tick — instant pull telemetry.
    Memory.status = snap;

    // 2) Human console summary, throttled.
    if (Game.time % LOG_INTERVAL === 0) this.logSummary(snap);
  },

  // Structured per-colony snapshot (JSON-friendly, compact).
  snapshot(colony) {
    const c = colony;
    const ctrl = c.controller;
    const health = c.health; // per-tick economy signals; also the single source for the site count

    const pop = {};
    for (const role in c.creepsByRole) pop[role] = c.creepsByRole[role].length;

    const overlords = c.overlords.map((o) => {
      let want = 0;
      try { want = o.desiredCount(); } catch { want = -1; }
      // Use the overlord's OWN creeps (per-instance for miners), not every
      // creep of the role — otherwise each per-source miner overlord would
      // report the room-wide miner count and look over-staffed.
      const have = o.assignedCreeps.length;
      return { role: o.role, have, want, ok: have >= want };
    });

    const { current, next, readyForNext } = nextStage(c);

    const extCap = (CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] || {})[ctrl.level] || 0;
    const extBuilt = c.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    const towerList = c.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });

    return {
      stage: current.key,
      nextStage: next ? next.key : null,
      readyForNext,
      rcl: ctrl.level,
      rclPct: ctrl.level >= 8 ? 100 : pct(ctrl.progress, ctrl.progressTotal),
      controllerTicksToDowngrade: ctrl.ticksToDowngrade,
      energy: { avail: c.room.energyAvailable, cap: c.room.energyCapacityAvailable },
      extensions: { built: extBuilt, cap: extCap },
      towers: {
        count: towerList.length,
        energy: towerList.reduce((sum, t) => sum + t.store[RESOURCE_ENERGY], 0),
      },
      sourceEnergy: sourceEnergy(c),
      pop,
      overlords,
      // Construction sites pending — same count health derives buildBacklog from,
      // so reuse it (one room.find/tick, no drift between the two).
      sites: health.buildBacklog,
      // Economic-dynamics signals driving creep counts (#81) — visible live so
      // the control loop is debuggable.
      health,
    };
  },

  // One-glance console lines for the in-game UI.
  logSummary(snap) {
    for (const name in snap.colonies) {
      const s = snap.colonies[name];
      const pop = Object.entries(s.pop).map(([r, n]) => `${r}×${n}`).join(" ") || "none";
      const staffing = s.overlords
        .map((o) => `${o.role}:${o.have}/${o.want}${o.ok ? "✅" : "⚠️"}`)
        .join(" ");
      const rcl = s.rcl >= 8 ? "RCL8(cap)" : `RCL${s.rcl} ${s.rclPct}%`;
      const nextHint = s.nextStage
        ? ` →${s.nextStage}${s.readyForNext ? "(READY)" : ""}`
        : "";
      const towerHint = s.towers.count
        ? ` | 🗼${s.towers.count}@${s.towers.energy}`
        : "";
      const healthHint = s.health
        ? ` | ${s.health.energyRich ? "💰rich" : "lean"} sat${Math.round(s.health.saturation * 100)}%` +
          ` idle${Math.round((s.health.spawnIdle || 0) * 100)}%${s.health.expansionReady ? " 🚀exp" : ""}`
        : "";
      log.info(
        `📊 ${name} [${s.stage}${nextHint}] ${rcl} | spawn ${s.energy.avail}/${s.energy.cap} | ` +
          `ext ${s.extensions.built}/${s.extensions.cap} | src ${s.sourceEnergy}${towerHint} | sites ${s.sites}${healthHint} | pop: ${pop}`
      );
      log.info(`   overlords: ${staffing}`);
    }
    log.info(
      `🌍 CPU ${snap.cpu.used}/${snap.cpu.limit} bucket=${snap.cpu.bucket} | ` +
        `GCL ${snap.gcl.level} ${snap.gcl.pct}%`
    );
  },
};
