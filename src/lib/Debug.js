// ============================================================================
//  Debug — a centralized, memory-gated debug INSTRUMENT (#215).
//
//  The standing replacement for the throwaway logger PRs we kept shipping to
//  master just to SEE a running entity (#207/#209) and the always-on per-creep
//  trace (#103). OFF BY DEFAULT ON EVERYTHING, ZERO-COST when off, flipped per
//  entity LIVE (no deploy), read delay-free from Memory.
//
//  It is a DEBUG instrument, NOT the console and NOT colony history. Logger.js
//  (important live warnings the human must see) and RoomLog.js (the room story)
//  stay exactly as they are. Debug is what you turn ON to inspect ONE misbehaving
//  entity, then turn back OFF — it must never become an everything-logger.
//
//  THE SWITCH — one array, Memory.debug.on:
//    A flat list of active keys. A CLASS/role name ("RemoteMiningOverlord",
//    "remoteHauler") enables every instance of it; an INSTANCE id ("remoteHauler_9370")
//    enables just one. EMPTY → the whole facility short-circuits off on a single
//    .length read (the normal, steady-state cost). Read PER CALL, never cached at
//    construction — the array is edited live (bin/sapi log), so a key added now
//    takes effect next tick even for a logger bound long ago. ALL-OFF empties the
//    array AND the rings, so a panic stop leaves a clean slate.
//
//  THE LOGGER — zero-cost when off:
//    Debug.for(klass, id).log(dataFn). dataFn is a CLOSURE invoked ONLY when active,
//    so the log object is built only when someone's watching — sprinkling log()
//    calls everywhere is free at rest. Each entry is { t: Game.time, ...dataFn() }
//    pushed to a capped per-id ring (Memory.debug.log[id]). A global row cap bounds
//    total debug memory so a forgotten active key (e.g. a whole role) can never
//    approach the 2 MB Memory ceiling.
//
//  Toggle + read from the CLI: bin/sapi log (on/off/all-off/read/list).
// ============================================================================
import { log } from "./Logger.js";

// Per-id ring rows kept (mirrors RoomLog's ROOM_LOG_LEN discipline). Tiny against
// the 2 MB cap; bounds the per-tick JSON cost of an active id.
const RING_LEN = 50;
// Hard cap on TOTAL debug rows across every id — the safety net against a forgotten
// active class accumulating rings for dozens of instances. Drop oldest beyond it.
const GLOBAL_MAX = 500;

export const Debug = {
  // Is logging active for this class/id right now? One .length short-circuit when
  // off (the steady state), then a membership test. Re-read every call — the array
  // is edited live, so nothing may be cached at the logger's construction.
  active(klass, id) {
    const on = Memory.debug && Memory.debug.on;
    return !!(on && on.length && (on.includes(klass) || on.includes(id)));
  },

  // A logger bound to one entity's class + id. Build it freely (even at init) — the
  // gate is checked at log() time, not here, so a bound-but-inactive logger is free.
  for(klass, id) {
    return { log: (dataFn) => this.record(klass, id, dataFn) };
  },

  // Append a debug row for (klass,id) IF active. dataFn is invoked only when active
  // (lazy — the data object is built only when someone's watching this entity).
  record(klass, id, dataFn) {
    if (!this.active(klass, id)) return;
    const store = (Memory.debug.log ||= {});
    const ring = store[id] || [];
    ring.push({ t: Game.time, ...dataFn() });
    if (ring.length > RING_LEN) ring.splice(0, ring.length - RING_LEN);
    store[id] = ring;
    this.enforceGlobalCap(store);
  },

  // Bound total rows across every ring. When active keys accumulate past the cap,
  // shave the LONGEST ring (the heaviest contributor) until under it — the facility
  // self-limits instead of risking the Memory ceiling on a forgotten switch. Returns
  // immediately when under cap (the steady state), so the eviction scan only runs on
  // overflow — a too-broad active key (e.g. a whole high-population role).
  enforceGlobalCap(store) {
    let total = 0;
    for (const k in store) total += store[k].length;
    if (total <= GLOBAL_MAX) return;
    // Over cap: warn so the operator knows debug is dropping data — but THROTTLED, never
    // spam the console the human keeps for real warnings (it stays lit until they narrow
    // Memory.debug.on or run `sapi log all-off`, so one line per ~100 ticks is enough).
    if (Game.time % 100 === 0) {
      log.warn(`Debug rings over cap (${total}/${GLOBAL_MAX}); dropping oldest — narrow Memory.debug.on or 'sapi log all-off'.`);
    }
    while (total > GLOBAL_MAX) {
      let biggest = null;
      for (const k in store) if (!biggest || store[k].length > store[biggest].length) biggest = k;
      if (!biggest || !store[biggest].length) break;
      store[biggest].shift();
      total--;
    }
  },

  // ALL-OFF: empty the switch AND clear the rings — one panic-stop reset.
  allOff() {
    Memory.debug = { on: [], log: {} };
  },
};
