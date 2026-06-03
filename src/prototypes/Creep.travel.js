import { TrafficManager } from "../lib/TrafficManager.js";
import { roleClass } from "../roles/index.js";

// ============================================================================
//  Creep.travelTo — register a movement INTENT, don't move immediately.
//
//  Roles call this exactly as before (`creep.travelTo(target)`); the signature
//  and "move one step toward target this tick" contract are unchanged. What
//  changed is the mechanism: instead of calling the engine's `moveTo` (which
//  blocks on any standing creep), we compute the desired NEXT tile and hand it
//  to the room's TrafficManager. After every colony has run, the manager
//  resolves all intents together (Kernel.tick → TrafficManager.resolveAll) so a
//  higher-priority creep can shove an idle one aside instead of being walled in.
//
//  Pathing routes AROUND other creeps by default, falling back to straight-
//  through (and letting the resolver shove) only when creeps block every route.
//  Why not always ignore creeps and let the resolver sort it out? Because the
//  resolver is per-tick and creep-blind paths are frozen: a blocked creep
//  re-submits the identical straight line every tick, so the resolver swaps/
//  shoves it, and next tick it offers the same move again — a stable oscillation
//  ("dancing") in any dense area, with no fixed point (#60). Routing around lets
//  a blocked creep's path adapt, so the conflict stops regenerating and it uses
//  the go-around tile. The straight-through fallback preserves the #55 ring-break
//  (a fully-ringed target has no path around, so we go straight and shove).
//
//  PATH COMMITMENT (restores moveTo's reusePath; mirrors Overmind's Movement):
//  the path is cached in creep.memory and COMMITTED — we just read the next tile
//  along it each tick, and we do NOT re-pathfind just because we didn't move.
//  This is what kills the left-right "dance": a blocked creep stays on its
//  committed path (the resolver keeps it in place — see candidateTiles' root
//  rule) instead of recomputing a different route every tick. We repath only
//  when: target changed, cache expired (REUSE_TICKS), we got shoved OFF the path,
//  reached the end, or we've been STUCK past STUCK_THRESHOLD ticks — then we
//  ESCALATE to a re-route, gated by a coin flip so two mutually-stuck creeps
//  desync instead of re-colliding. Also cuts pathfinding ~20× vs recompute-each-
//  tick.
//
//  Unlike moveTo, this returns nothing — it's purely side-effectful (registers an
//  intent). Callers infer "did I move?" from next tick's position, never a return
//  code; every call site already follows the `if (action === ERR_NOT_IN_RANGE)
//  travelTo(...)` idiom and ignores the result.
//
//  Options:
//    range     — stop this many tiles from the target (default 0; like moveTo,
//                an unwalkable target yields a path ending adjacent to it).
//    priority  — movement priority for tile contention (lower wins). Defaults to
//                the creep's Role.movementPriority; pass to override per-call
//                (the hook a future Behavior uses to re-rank a single creep).
//    pathOpts  — extra options forwarded to findPathTo for tuning (e.g.
//                plainCost/swampCost). Cannot override ignoreCreeps or maxRooms
//                — travelTo locks both: creep-avoidance is the resolver's job and
//                resolution is per-room.
//    visualize — draw the intended path as a dashed line (default true; pass
//                false to silence it in busy rooms).
// ============================================================================

const REUSE_TICKS = 20; // recompute a committed path at least this often (like moveTo)
const STUCK_THRESHOLD = 2; // ticks without moving before we re-route (Overmind's DEFAULT_STUCK_VALUE)
const pack = (x, y) => x * 50 + y; // tile -> unique int (rooms are 50×50)
const unpackX = (n) => Math.floor(n / 50);
const unpackY = (n) => n % 50;

// Fresh path toward target: route around creeps, fall back to straight-through
// (resolver shoves) only when creeps block every route. Returns the findPathTo
// array (steps after the current tile), possibly empty (already in range).
function computePath(creep, targetPos, pathOpts) {
  let path = creep.pos.findPathTo(targetPos, { ...pathOpts, ignoreCreeps: false });
  if (path.length === 0) {
    path = creep.pos.findPathTo(targetPos, { ...pathOpts, ignoreCreeps: true });
  }
  return path;
}

Creep.prototype.travelTo = function (target, opts = {}) {
  const targetPos = target.pos || target;
  if (this.pos.isEqualTo(targetPos)) return;
  // Can't move this tick — don't spend a pathfind or register an intent (the
  // resolver ignores fatigued/spawning creeps anyway). The committed path in
  // memory is preserved untouched, so we resume it when able.
  if (this.spawning || this.fatigue > 0) return;

  // maxRooms is spread LAST so caller pathOpts can tune costs but never break the
  // per-room invariant the resolver depends on.
  const pathOpts = { range: opts.range ?? 0, ...opts.pathOpts, maxRooms: 1 };
  // range is part of the cache identity: the same target tile with a different
  // stop distance is a different path.
  const destKey = `${pack(targetPos.x, targetPos.y)}:${targetPos.roomName}:${pathOpts.range}`;
  const here = pack(this.pos.x, this.pos.y);

  // The cached path is packed tiles INCLUDING our start, so our current tile sits
  // at some index along it while we're on-route. indexOf < 0 means we're off it.
  let cache = this.memory._t;
  const sameDest = cache && cache.dest === destKey;

  // Stuck counter (Overmind's model): count CONSECUTIVE ticks we didn't move. We
  // commit to the cached path — we do NOT repath just because we didn't move —
  // and only after STUCK_THRESHOLD ticks do we ESCALATE to a re-route, gated by a
  // coin flip so two mutually-stuck creeps desync instead of re-colliding. This
  // is what stops the left-right "dance": a blocked creep stays on its committed
  // path (the resolver keeps it in place — see candidateTiles root rule) and
  // patiently waits, rather than recomputing a different path every tick.
  if (sameDest && Game.time > cache.lastTick) {
    cache.stuck = here === cache.last ? (cache.stuck || 0) + 1 : 0;
  }
  const escalate =
    sameDest && (cache.stuck || 0) >= STUCK_THRESHOLD && Math.random() < 0.5;

  const onPath = sameDest ? cache.path.indexOf(here) : -1;
  const stale =
    !sameDest || // no cache / new destination
    Game.time - cache.time >= REUSE_TICKS || // periodic refresh
    onPath === -1 || // shoved off our committed path → repath from here
    onPath + 1 >= cache.path.length || // reached the end of the route
    escalate; // stuck too long → re-route around the blocker

  if (stale) {
    const path = computePath(this, targetPos, pathOpts);
    if (path.length === 0) {
      // Already as close as we can get — caller's range check / action handles it.
      this.memory._t = undefined;
      return;
    }
    cache = {
      dest: destKey,
      path: [here, ...path.map((s) => pack(s.x, s.y))],
      time: Game.time,
      stuck: 0,
    };
    this.memory._t = cache;
  }

  // Record where/when we are, to detect "didn't move since last tick" next time.
  cache.last = here;
  cache.lastTick = Game.time;

  // After a (re)compute, `here` is path[0]; otherwise reuse the index we already
  // found (avoids a second linear scan of the path each tick).
  const idx = stale ? 0 : onPath;
  const nextPacked = cache.path[idx + 1];
  const nextPos = new RoomPosition(unpackX(nextPacked), unpackY(nextPacked), this.room.name);
  const priority = opts.priority ?? roleClass(this.memory.role).movementPriority;
  TrafficManager.for(this.room).register(this, nextPos, priority);

  // Debug viz: the remaining path as a dashed line, so a creep's destination and
  // route (around vs straight-through) are visible at a glance.
  if (opts.visualize !== false) {
    const points = cache.path.slice(idx).map((n) => [unpackX(n), unpackY(n)]);
    new RoomVisual(this.room.name).poly(points, {
      stroke: "#ffaa00",
      opacity: 0.3,
      lineStyle: "dashed",
    });
  }
};
