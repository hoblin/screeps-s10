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
//                plainCost/swampCost). Cannot override maxRooms (single-room is
//                an invariant the resolver depends on) — that's locked below.
//    visualize — draw the intended path as a dashed line (default true; pass
//                false to silence it in busy rooms).
// ============================================================================
Creep.prototype.travelTo = function (target, opts = {}) {
  const targetPos = target.pos || target;
  if (this.pos.isEqualTo(targetPos)) return;

  // maxRooms is spread LAST so caller pathOpts can tune costs but never break the
  // per-room invariant the resolver depends on.
  const pathOpts = { range: opts.range ?? 0, ...opts.pathOpts, maxRooms: 1 };

  // Prefer a path that routes AROUND other creeps so a blocked creep adapts
  // instead of dancing (see header). If creeps block every route to the target
  // (e.g. a full ring), no such path exists — fall back to a straight, creep-
  // agnostic path and let the resolver shove through.
  let path = this.pos.findPathTo(targetPos, { ...pathOpts, ignoreCreeps: false });
  if (path.length === 0) {
    path = this.pos.findPathTo(targetPos, { ...pathOpts, ignoreCreeps: true });
  }
  // An empty path now means we're already as close as we can get — the caller's
  // range check / action handles it; we simply don't move.
  if (path.length === 0) return;

  const step = path[0];
  const nextPos = new RoomPosition(step.x, step.y, this.room.name);
  const priority = opts.priority ?? roleClass(this.memory.role).movementPriority;
  TrafficManager.for(this.room).register(this, nextPos, priority);

  // Debug viz: the full intended path as a dashed line, so a creep's destination
  // and route (around vs straight-through) are visible at a glance.
  if (opts.visualize !== false) {
    const points = [[this.pos.x, this.pos.y], ...path.map((s) => [s.x, s.y])];
    new RoomVisual(this.room.name).poly(points, {
      stroke: "#ffaa00",
      opacity: 0.3,
      lineStyle: "dashed",
    });
  }
};
