import { Colony } from "./Colony.js";
import { log } from "./lib/Logger.js";
import { Dashboard } from "./lib/Dashboard.js";
import { TrafficManager } from "./lib/TrafficManager.js";
import { Threat } from "./lib/Threat.js";

// How many ticks of behaviour to keep per creep (#103). A capped ring buffer —
// tiny against the 2 MB Memory cap (a few dozen creeps × a handful of small
// entries) — that turns "why is this creep doing that?" into one get_memory read.
const CREEP_TRACE_LEN = 5;

// Threat-intel overlay housekeeping (#105). Pruning is cheap but pointless every
// tick, so run it on an interval; only forget rooms unseen for far longer than
// Threat's freshness window (1000 ticks), so a prune never drops intel still in use.
const INTEL_PRUNE_INTERVAL = 1500; // ticks between prune passes
const INTEL_MAX_AGE = 10000; // forget intel for rooms unseen this long

// ============================================================================
//  Kernel — the top-level orchestrator (think: the Rails app object).
//  Responsibilities:
//   - CPU bucket guard (skip expensive work when starved)
//   - discover owned rooms and wrap each in a Colony
//   - drive the per-tick pipeline
//   - cleanup dead creep memory
// ============================================================================
export class Kernel {
  constructor() {
    this.colonies = {};
  }

  tick() {
    this.cleanupMemory();
    this.migrateLegacyHarvesters(); // must precede buildColonies (it groups by role)

    // Bucket guard: if CPU bucket is low, run only the essentials.
    const lowBucket = Game.cpu.bucket < 500;
    if (lowBucket) {
      log.warn(`Low CPU bucket (${Game.cpu.bucket}); running minimal tick.`);
    }

    this.buildColonies();

    // Threat intel: refresh every VISIBLE room's threat level BEFORE the colony loop,
    // so this tick's flee/avoid + remote target selection act on a current reading
    // (#105). Vision == our presence, so this covers every room a creep is standing in.
    this.updateRoomIntel();

    for (const name in this.colonies) {
      try {
        this.colonies[name].run(lowBucket);
      } catch (err) {
        log.error(`Colony ${name} crashed: ${err.stack || err}`);
      }
    }

    // Movement: roles registered travel INTENTS instead of moving. Now that every
    // colony has run, resolve them all by priority in one pass — so a hauler/miner
    // shoves idle creeps aside instead of being walled in (issue #55). Must run
    // after the colony loop and before telemetry.
    try {
      TrafficManager.resolveAll(lowBucket);
    } catch (err) {
      log.error(`TrafficManager.resolveAll crashed: ${err.stack || err}`);
    }

    // Behaviour trace: now that movement is resolved (positions are final), fold
    // each creep's intent tag + final position into its rolling log (#103).
    this.recordCreepTraces();

    // Telemetry: write Memory.status every tick (instant pull), log summary
    // periodically. Always run — status is cheap and most useful when starved.
    Dashboard.run(this.colonies);
  }

  // Wrap every owned room (with a spawn) in a Colony object.
  buildColonies() {
    this.colonies = {};
    for (const name in Game.rooms) {
      const room = Game.rooms[name];
      if (room.controller && room.controller.my) {
        this.colonies[name] = new Colony(room);
      }
    }
  }

  // Refresh the threat overlay for every room we can see this tick (#105). One
  // assess per visible room — deduped by construction (Game.rooms is a set), so N
  // creeps in a room cost one scan, not N. Wrapped so a single bad room can't abort
  // the rest. Game.rooms is the rooms we have vision of = where our creeps are.
  updateRoomIntel() {
    for (const name in Game.rooms) {
      try {
        Threat.observe(Game.rooms[name]);
      } catch (err) {
        log.error(`Threat.observe(${name}) crashed: ${err.stack || err}`);
      }
    }
    // Occasionally forget long-abandoned rooms so the intel overlay stays bounded.
    if (Game.time % INTEL_PRUNE_INTERVAL === 0) Threat.prune(INTEL_MAX_AGE);
  }

  // Append one behaviour breadcrumb per living creep to its capped rolling log
  // (#103). Runs after TrafficManager.resolveAll so positions are the committed
  // final tiles, not pre-move intents. Each entry pairs the creep's final
  // position + working state with the intent tag a role stamped via Role.note
  // this tick (cleared after, so a tick with no note() just records where it
  // ended up). Iterates Game.creeps so remote creeps in unowned rooms — the ones
  // hardest to debug — are covered too. Dead creeps' memory (and their logs) is
  // reaped by cleanupMemory next tick.
  recordCreepTraces() {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.spawning) continue; // not on the field yet — nothing to trace
      const m = creep.memory;
      const trace = m.log || []; // not `log` — that's the module-level logger import
      trace.push({
        tick: Game.time,
        room: creep.pos.roomName,
        x: creep.pos.x,
        y: creep.pos.y,
        working: !!m.working,
        act: m._act,
      });
      if (trace.length > CREEP_TRACE_LEN) trace.splice(0, trace.length - CREEP_TRACE_LEN);
      m.log = trace;
      m._act = undefined; // consumed — don't carry a stale tag into next tick
    }
  }

  // Release memory of creeps that no longer exist.
  cleanupMemory() {
    if (!Memory.creeps) return;
    for (const name in Memory.creeps) {
      if (!(name in Game.creeps)) {
        delete Memory.creeps[name];
      }
    }
  }

  // One-time migration: the Stage 2 refactor renamed the mobile "harvester"
  // role to the static "miner" role, owned per-source by a MiningOverlord.
  // Any harvester alive at deploy time would otherwise be orphaned (no overlord
  // drives it) while a fresh miner spawns alongside it — a wasteful duplicate.
  // Re-tag living harvesters as miners so the new overlords adopt them and let
  // them live out their days under management. Safe to run every tick; it only
  // touches creeps still carrying the legacy role.
  migrateLegacyHarvesters() {
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.role !== "harvester") continue;

      creep.memory.role = "miner";

      // Every migrated creep MUST end up bound to a MiningOverlord, otherwise no
      // overlord claims it (orphan) AND it counts toward no quota (so a fresh
      // miner spawns as a duplicate). The legacy Harvester assigned its source
      // lazily, so a creep that hadn't run yet (or was still spawning) has no
      // sourceId. In that case, pick the source nearest the creep so it binds
      // to a real overlord.
      let sourceId = creep.memory.sourceId;
      if (!sourceId) {
        const nearestSource = creep.pos.findClosestByRange(FIND_SOURCES);
        sourceId = nearestSource ? nearestSource.id : null;
        creep.memory.sourceId = sourceId;
      }
      if (!sourceId) continue; // no sources visible at all — leave as-is

      // Bind to the MiningOverlord of that source. The identifier must match
      // MiningOverlord.identifier exactly ("miner:<full-sourceId>").
      creep.memory.overlord = `miner:${sourceId}`;
      // The overlord re-stamps miningPos on adopted creeps that lack it (see
      // MiningOverlord.run), and Miner.run falls back to the source directly
      // when miningPos is still null, so no creep ever gets stuck.
      creep.memory.miningPos = null;
    }
  }
}
