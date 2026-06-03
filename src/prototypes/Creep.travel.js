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
//  Options:
//    range     — stop this many tiles from the target (default 0; like moveTo,
//                an unwalkable target yields a path ending adjacent to it).
//    priority  — movement priority for tile contention (lower wins). Defaults to
//                the creep's Role.movementPriority; pass to override per-call
//                (the hook a future Behavior uses to re-rank a single creep).
//    pathOpts  — extra options forwarded to findPathTo (rarely needed).
// ============================================================================
Creep.prototype.travelTo = function (target, opts = {}) {
  const targetPos = target.pos || target;
  if (this.pos.isEqualTo(targetPos)) return;

  // One path step toward the target, creep-agnostic (traffic resolver handles
  // creeps). An empty path means we're already as close as we can get — the
  // caller's range check / action will handle it; we simply don't move.
  const path = this.pos.findPathTo(targetPos, {
    ignoreCreeps: true,
    maxRooms: 1,
    range: opts.range ?? 0,
    ...opts.pathOpts,
  });
  if (path.length === 0) return;

  const step = path[0];
  const nextPos = new RoomPosition(step.x, step.y, this.room.name);
  const priority = opts.priority ?? roleClass(this.memory.role).movementPriority;
  TrafficManager.for(this.room).register(this, nextPos, priority);

  // Light debug viz: a faint line to the tile we're requesting this tick.
  new RoomVisual(this.room.name).line(this.pos, nextPos, {
    color: "#ffaa00",
    opacity: 0.3,
  });
};
