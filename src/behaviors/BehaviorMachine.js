import { behaviorClass } from "./index.js";

// ============================================================================
//  BehaviorMachine — the per-creep trigger state machine (#39).
//
//  The creep-level analog of the colony Stages machine (src/lib/Stages.js),
//  built one level down. A creep declares a SET of behavior nodes in memory:
//
//    creep.memory.behaviors = { default: "holdPoint", nodes: ["focusFire"] }
//
//  re-assignable on the fly — the #174 command interface (or a bare set_memory)
//  rewrites it and the switch takes effect next tick, so a live warband is
//  retaskable mid-fight without respawning.
//
//  Shape (the voice-note design): a small state machine whose NODES are Behaviors
//  and whose EDGES are paired triggers, with ONE default node.
//   • The DEFAULT node runs with no trigger — the baseline conduct (a commanded
//     mission, or a fallback).
//   • Each SPECIAL node (listed in `nodes`) carries an entry edge `enteredWhen`
//     that pulls the creep INTO it from the default, and an exit edge `exitWhen`
//     that releases it back. Symmetric edges in/out of a node, like the stage
//     machine's enteredWhen/readyForNextWhen.
//
//  STATEFUL (unlike the stateless colony Stages recompute): the active node
//  persists in creep.memory.behavior — a creep STAYS in a node until that node's
//  exit edge fires. From the default, the FIRST special node whose entry edge
//  fires preempts (like an override Stage).
// ============================================================================
export class BehaviorMachine {
  // Drive one creep: resolve the active node, persist it, run it.
  static run(creep, colony) {
    const set = creep.memory.behaviors;
    if (!set || !set.default) return; // no declared conduct → inert (nothing to do)
    const active = this.select(creep, colony, set);
    creep.memory.behavior = active;
    const behavior = behaviorClass(active);
    if (behavior) behavior.run(creep, colony);
  }

  // Resolve which node is active this tick. Returns the node key.
  static select(creep, colony, set) {
    const current = creep.memory.behavior || set.default;
    const specials = set.nodes || [];

    // Currently in a SPECIAL node: hold it ONLY while it exists AND its exit edge is
    // defined and not yet firing. A special node with no exit edge can't trap the creep
    // — it falls back to the default, so a partial/misconfigured behavior never silently
    // pins a creep in an override state. A deliberate latch must say so: `exitWhen: () => false`.
    if (current !== set.default && specials.includes(current)) {
      const node = behaviorClass(current);
      if (node && node.exitWhen && !node.exitWhen(creep, colony)) return current; // stay
      // exit fired / no exit edge / node vanished from the registry → drop to default below
    }

    // In the default: an entry edge can preempt it. First special node whose entry
    // trigger fires wins (declaration order = priority, like the Stages override scan).
    for (const name of specials) {
      const node = behaviorClass(name);
      if (node && node.enteredWhen && node.enteredWhen(creep, colony)) return name;
    }
    return set.default;
  }
}
