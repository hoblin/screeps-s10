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

const LOG_INTERVAL = 30; // ticks between human console summaries

// Infer the colony's economic stage from RCL + key structures.
// Mirrors STRATEGY.md stages so telemetry speaks the same language as the plan.
function stageOf(colony) {
  const rcl = colony.controller.level;
  const room = colony.room;
  const has = (t) => room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === t }).length;
  if (rcl >= 8) return "5:Endgame/Score";
  if (rcl >= 6) return "4:Industry";
  if (rcl >= 4 || has(STRUCTURE_STORAGE)) return "3:Storage&Links";
  if (rcl >= 2 || has(STRUCTURE_CONTAINER)) return "2:StaticMining";
  return "1:Bootstrap";
}

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

    const pop = {};
    for (const role in c.creepsByRole) pop[role] = c.creepsByRole[role].length;

    const overlords = c.overlords.map((o) => {
      let want = 0;
      try { want = o.desiredCount(); } catch { want = -1; }
      const have = c.creepsWithRole(o.role).length;
      return { role: o.role, have, want, ok: have >= want };
    });

    return {
      stage: stageOf(c),
      rcl: ctrl.level,
      rclPct: ctrl.level >= 8 ? 100 : pct(ctrl.progress, ctrl.progressTotal),
      controllerTicksToDowngrade: ctrl.ticksToDowngrade,
      energy: { avail: c.room.energyAvailable, cap: c.room.energyCapacityAvailable },
      sourceEnergy: sourceEnergy(c),
      pop,
      overlords,
      // Construction sites pending (useful once we start building).
      sites: c.room.find(FIND_MY_CONSTRUCTION_SITES).length,
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
      log.info(
        `📊 ${name} [${s.stage}] ${rcl} | spawn ${s.energy.avail}/${s.energy.cap} | ` +
          `src ${s.sourceEnergy} | sites ${s.sites} | pop: ${pop}`
      );
      log.info(`   overlords: ${staffing}`);
    }
    log.info(
      `🌍 CPU ${snap.cpu.used}/${snap.cpu.limit} bucket=${snap.cpu.bucket} | ` +
        `GCL ${snap.gcl.level} ${snap.gcl.pct}%`
    );
  },
};
