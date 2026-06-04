import { log } from "./Logger.js";

// ============================================================================
//  RoomLog — a per-room "story" log (#107).
//
//  The room analog of the per-creep behaviour trace (#103): a hard-capped ring
//  buffer in Memory recording NOTABLE EVENTS — tower kills, hostiles appearing /
//  clearing, recovery flips, RCL/stage advances — so "what happened in this room
//  lately" is one `get_memory roomLog.<room>` read instead of catching it live or
//  reconstructing from API polls. Each event also echoes to the console (events are
//  rare, so no spam), giving both a live feed and a persistent pull log.
//
//  EVENT-driven, not per-tick: callers invoke record() only on transitions, so the
//  log reads as a story rather than noise. Stored at top-level `Memory.roomLog`
//  keyed by room name (mirrors Threat's `Memory.roomIntel`, #105) — events fire for
//  remote rooms too, which have no owning Colony to hang state on.
// ============================================================================

// Hard cap: events kept per room (ring buffer, oldest dropped). Tiny against the
// 2 MB Memory cap — events are rare, entries are terse — and bounds the per-tick
// JSON cost. Mirrors the creep trace's CREEP_TRACE_LEN discipline.
const ROOM_LOG_LEN = 30;

export const RoomLog = {
  // Append a room event to its capped ring buffer and echo it to the console.
  // `event` is a short emoji-tagged label ("🗼 killed", "⚔️ hostiles"); `detail`
  // is a small flat object (owner, hp, to-level…) merged into the stored entry and
  // rendered as a `k=v` suffix on the console line.
  record(roomName, event, detail = {}) {
    Memory.roomLog ||= {};
    const buf = Memory.roomLog[roomName] || [];
    buf.push({ tick: Game.time, event, ...detail });
    if (buf.length > ROOM_LOG_LEN) buf.splice(0, buf.length - ROOM_LOG_LEN);
    Memory.roomLog[roomName] = buf;
    log.info(`📜 ${roomName} ${event}${this.fmt(detail)}`);
  },

  // Compact " k=v k=v" suffix for the console line; the stored entry keeps the
  // fields as-is for structured reads.
  fmt(detail) {
    const parts = Object.entries(detail).map(([k, v]) => `${k}=${v}`);
    return parts.length ? " " + parts.join(" ") : "";
  },
};
