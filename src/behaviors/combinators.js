// ============================================================================
//  Behavior combinators (#188) — compose atom Behaviors into trees.
//
//  The whole composition layer rests on ONE contract: every Behavior's
//  `run(creep, colony, ctx?)` returns a BOOLEAN — "did I act / produce an intent
//  this tick?". From that boolean the combinators fall out with no per-composite
//  conditionals:
//
//   • fallback (selector) — try children in order; the FIRST that returns true
//     wins and the rest don't run. The canonical "do A, else B": e.g.
//     `fallback(Kite, Regroup)` kites when an enemy is present, else regroups —
//     because Kite returns false exactly when there's nothing to kite.
//   • sequence — run children in order until one returns false; true iff all ran.
//
//  These are plain functions (not a data-driven BT VM with Sequence/Parallel node
//  types as data) — a deliberate over-engineering guardrail: a creep makes a
//  shallow per-tick decision, so CODE composites + these two helpers are enough.
//  `compound` (several intents in one tick) is deferred until a real consumer
//  (a kiting medic) exists.
//
//  `ctx` is an OPTIONAL context (an explicit target/anchor) threaded to every
//  child: absent → each atom self-selects (nearest enemy / squad anchor); present
//  → the atom acts on the passed target. This is what lets `Kite` be reused inside
//  a future focusFire to burst a SHARED target instead of its own nearest one.
// ============================================================================

// First child whose run() returns truthy wins; returns whether any child acted.
export function fallback(creep, colony, behaviors, ctx) {
  for (const behavior of behaviors) {
    if (behavior.run(creep, colony, ctx)) return true;
  }
  return false;
}

// Run children in order until one returns falsy; returns true iff every child acted.
export function sequence(creep, colony, behaviors, ctx) {
  for (const behavior of behaviors) {
    if (!behavior.run(creep, colony, ctx)) return false;
  }
  return true;
}
