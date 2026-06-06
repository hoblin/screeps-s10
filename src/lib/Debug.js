import { log } from "./Logger.js";

// ============================================================================
//  Debug — a centralized, memory-gated, level'd debug logger (#215).
//
//  The standing replacement for throwaway logger PRs (#207/#209's `rhaulLog`):
//  a permanent facility that is OFF on everything by default, near-zero-cost when
//  off, flippable PER ENTITY live (no deploy), and read delay-free from Memory.
//
//  THE SWITCH — one map `Memory.debug.on` = { <klass-or-id>: level }. A CLASS key
//  (a role name like "remoteHauler", or an overlord class) enables every instance;
//  an INSTANCE id (a creep name) enables just one. ABSENT `Memory.debug` → the whole
//  facility short-circuits off on one property read (the cheapest gate, safe in any
//  hot loop). The map is re-read EVERY call, never cached — a freshly-added target
//  takes effect next tick (an entity that bound its logger at construction still sees
//  the change). ALL-OFF = `delete Memory.debug` (one place: drops map AND rings).
//
//  TWO LEVELS (mirroring Logger.js's level gate), so verbosity is opt-in — the archive
//  doctrine is "edge-only for event logs, ring for per-tick state; mixing = noise":
//    1 = events  (.event) — state TRANSITIONS only: behavior changed, gather↔deliver
//                           flipped, target assigned/revoked, reached a room, spawned.
//    2 = trace   (.trace) — events PLUS per-tick steps (the old rhaulLog roster). The
//                           call-site picks via the method, so the level is never
//                           hardcoded and a verbose stream is explicitly opted into.
//
//  ZERO-COST WHEN OFF — the data builder is a CLOSURE: `Debug.for(k,id).event(() => ({…}))`.
//  The object is built ONLY past the gate, so calling it everywhere is free at rest
//  (one Memory.debug read + return; no Memory write happens until a target is enabled).
// ============================================================================

// Rows kept per id (ring buffer, oldest dropped). Matches the old rhaulLog's depth
// (#207) and the CREEP_TRACE_LEN/ROOM_LOG_LEN discipline (#103/#107).
const DEBUG_RING_LEN = 50;
// Hard ceiling on total rows across ALL rings — a backstop so a forgotten active
// target can never approach the 2 MB Memory cap (50 ids × 50 rows still < this).
// Realistic use (1–3 active targets) never reaches it; it only bounds the worst case.
const DEBUG_TOTAL_CAP = 2000;

// Verbosity levels a target can be enabled at (mirrors Logger's numeric gate).
const LEVEL = { event: 1, trace: 2 };

export const Debug = {
  // The enabled level for (klass, id): an INSTANCE entry wins over its CLASS entry;
  // 0 = off. Re-read every call (never cached) so a live toggle applies next tick.
  // The `!Memory.debug` short-circuit is the facility's whole at-rest cost.
  level(klass, id) {
    const dbg = Memory.debug;
    if (!dbg) return 0;
    const on = dbg.on || {};
    // Coerce to a finite number: a manual Memory edit / sapi typo can leave a
    // non-numeric value, and `NaN < need` is false → it would WRONGLY open the gate.
    // Garbage fails CLOSED (treated as off), so a malformed switch never logs.
    const n = Number(on[id] ?? on[klass]);
    return Number.isFinite(n) ? n : 0;
  },

  // A logger bound to one entity. `.event`/`.trace` take a CLOSURE that builds the
  // log object — invoked only when the entity is enabled at the needed level.
  for(klass, id) {
    return {
      event: (dataFn) => this.write(klass, id, LEVEL.event, dataFn),
      trace: (dataFn) => this.write(klass, id, LEVEL.trace, dataFn),
    };
  },

  // Gate, then append `{ ...data, t }` to the id's capped ring. dataFn runs only past
  // the gate, so building the payload costs nothing when off. No Memory is written
  // until a target is enabled (level >= need implies Memory.debug exists).
  //
  // The bot must NEVER die for a debug log: a dataFn that throws or returns a
  // non-object is caught and recorded, not propagated. `t` is spread LAST so the tick
  // stamp can't be clobbered by a payload field of the same name.
  write(klass, id, need, dataFn) {
    if (this.level(klass, id) < need) return;
    let data;
    try {
      data = dataFn();
    } catch (err) {
      data = { err: String((err && err.message) || err) };
    }
    if (!data || typeof data !== "object") data = { v: data };
    const dbg = (Memory.debug ||= { on: {} });
    const logs = (dbg.log ||= {});
    const ring = logs[id] || [];
    ring.push({ ...data, t: Game.time });
    if (ring.length > DEBUG_RING_LEN) ring.splice(0, ring.length - DEBUG_RING_LEN);
    logs[id] = ring;
    this.enforceTotalCap(logs);
  },

  // Backstop: if total rows across all rings exceed the ceiling (a target left on for
  // thousands of ticks), drop oldest from the longest rings until under the cap and
  // warn. Unreachable in normal use; bounds the pathological case well under 2 MB.
  enforceTotalCap(logs) {
    const ids = Object.keys(logs);
    let total = 0;
    for (const id of ids) total += logs[id].length;
    let overflow = total - DEBUG_TOTAL_CAP;
    if (overflow <= 0) return;
    // Single pass: trim the overflow off the largest rings first (oldest rows), one
    // sweep — no per-dropped-row search for the current longest (the prior O(rows·ids)
    // worst case). Sort once, take a min(overflow, len) bite from each until cleared.
    ids.sort((a, b) => logs[b].length - logs[a].length);
    for (const id of ids) {
      if (overflow <= 0) break;
      const take = Math.min(overflow, logs[id].length);
      logs[id].splice(0, take);
      overflow -= take;
    }
    log.warn(`Debug rings hit total cap ${DEBUG_TOTAL_CAP} — trimmed oldest`);
  },

  // ALL-OFF: drop the whole facility (map + every ring) in one place, so a panic stop
  // leaves a clean slate and the cheapest gate (absent Memory.debug).
  allOff() {
    delete Memory.debug;
  },
};
