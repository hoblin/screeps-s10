// ============================================================================
//  Dashboard — periodic colony status report to the console.
//  Purpose: understand colony STATE at a glance (stage, economy, population,
//  overlords) instead of watching individual creeps crawl around the map.
//
//  Printed every REPORT_INTERVAL ticks (cheap; off by default for low bucket).
//  Read it via the screeps MCP `get_console` — this is our telemetry.
// ============================================================================
import { log } from "./Logger.js";

const REPORT_INTERVAL = 15; // ticks between full reports

// Infer the colony's economic stage from RCL + key structures.
// Mirrors STRATEGY.md stages so the log speaks the same language as the plan.
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

// Energy in the source(s) we can still mine this regen window.
function sourceEnergy(colony) {
  return colony.sources.reduce((a, s) => a + s.energy, 0);
}

// One compact bar like progress=1234/12000 (10%).
function pct(cur, max) {
  if (!max) return `${cur}`;
  return `${cur}/${max} (${Math.floor((cur / max) * 100)}%)`;
}

export const Dashboard = {
  // Called once per tick by the Kernel; self-throttles to REPORT_INTERVAL.
  maybeReport(colonies) {
    if (Game.time % REPORT_INTERVAL !== 0) return;
    for (const name in colonies) {
      try {
        this.report(colonies[name]);
      } catch (err) {
        log.error(`Dashboard ${name}: ${err.stack || err}`);
      }
    }
    // Global footer: CPU + GCL health.
    const cpu = Game.cpu;
    log.info(
      `🌍 CPU ${cpu.getUsed().toFixed(1)}/${cpu.limit} bucket=${cpu.bucket} | ` +
        `GCL ${Game.gcl.level} ${pct(Game.gcl.progress, Game.gcl.progressTotal)}`
    );
  },

  report(colony) {
    const c = colony;
    const ctrl = c.controller;
    const stage = stageOf(c);

    // Population by role: harvester×2 worker×1 ...
    const pop = Object.entries(c.creepsByRole)
      .map(([role, list]) => `${role}×${list.length}`)
      .join(" ") || "none";

    // Per-overlord want vs have — shows if we're under-staffed.
    const staffing = c.overlords
      .map((o) => {
        let want = 0;
        try { want = o.desiredCount(); } catch { want = -1; }
        const have = c.creepsWithRole(o.role).length;
        const flag = have < want ? "⚠️" : "✅";
        return `${o.role}:${have}/${want}${flag}`;
      })
      .join(" ");

    const energy = `spawn ${c.room.energyAvailable}/${c.room.energyCapacityAvailable}`;
    const src = `src ${sourceEnergy(c)}`;
    const ctrlLine = ctrl.level >= 8
      ? `RCL8 (capped)`
      : `RCL${ctrl.level} ${pct(ctrl.progress, ctrl.progressTotal)}`;

    log.info(
      `📊 ${c.name} [${stage}] ${ctrlLine} | ${energy} | ${src} | pop: ${pop}`
    );
    log.info(`   overlords: ${staffing}`);
  },
};
