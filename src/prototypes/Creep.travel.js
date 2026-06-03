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
//  Pathing ignores creeps on purpose — the traffic resolver, not the pathfinder,
//  handles creep conflicts. That keeps each creep's path short and stable (no
//  oscillating detours around movers) and lets priority decide who yields.
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
//                plainCost/swampCost). Cannot override the resolver's invariants
//                (ignoreCreeps / maxRooms) — those are locked below.
//    visualize — draw a faint debug line to the requested tile (default true;
//                pass false to silence it in busy rooms).
// ============================================================================
Creep.prototype.travelTo = function (target, opts = {}) {
  const targetPos = target.pos || target;
  if (this.pos.isEqualTo(targetPos)) return;

  // One path step toward the target. An empty path means we're already as close
  // as we can get — the caller's range check / action handles it; we don't move.
  // `ignoreCreeps` and `maxRooms` are spread LAST so caller pathOpts can tune
  // costs but never break the two invariants the resolver depends on:
  //   - ignoreCreeps: the traffic resolver, not the pathfinder, avoids creeps
  //     (keeps paths short and stable; priority decides who yields).
  //   - maxRooms: 1: resolution is per-room (multi-room routing is out of scope).
  const path = this.pos.findPathTo(targetPos, {
    range: opts.range ?? 0,
    ...opts.pathOpts,
    ignoreCreeps: true,
    maxRooms: 1,
  });
  if (path.length === 0) return;

  const step = path[0];
  const nextPos = new RoomPosition(step.x, step.y, this.room.name);
  const priority = opts.priority ?? roleClass(this.memory.role).movementPriority;
  TrafficManager.for(this.room).register(this, nextPos, priority);

  // Light debug viz: a faint line to the tile we're requesting this tick.
  if (opts.visualize !== false) {
    new RoomVisual(this.room.name).line(this.pos, nextPos, {
      color: "#ffaa00",
      opacity: 0.3,
    });
  }
};
