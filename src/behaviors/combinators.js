// ============================================================================
//  Behavior combinators (#188) — compose atom Behaviors into trees.
//
//  The composition layer rests on ONE contract: a COMPOSABLE behavior's
//  `run(creep, colony, ctx?)` returns a BOOLEAN — "did I act / produce an intent
//  this tick?". This holds for the atoms here (Kite/Regroup) and any composite built
//  on these combinators; the rest of the legacy catalog (FocusFire/RaidRoom/… ) still
//  returns void and migrates onto the contract in #189. From that boolean the
//  combinators fall out with no per-composite conditionals:
//
//   • fallback (selector) — try children in order; the FIRST that returns true
//     wins and the rest don't run. The canonical "do A, else B": e.g.
//     `fallback(Kite, Regroup)` kites when an enemy is present, else regroups —
//     because Kite returns false exactly when there's nothing to kite.
//   • sequence — run children in order until one returns false; true iff all ran.
//   • compound (parallel) — run EVERY child; each emits to its OWN intent channel
//     (a Screeps creep moves + shoots + heals in ONE tick), returns true if any
//     acted. The kite tree `compound(Shoot, Reposition, GroupHeal)`: the shot is a
//     SIBLING of the retreat step, never gated by it — we fire AND step back the same
//     tick instead of throwing away damage while fleeing (#280).
//
//  These are plain functions (not a data-driven BT VM with Sequence/Parallel node
//  types as data) — a deliberate over-engineering guardrail: a creep makes a
//  shallow per-tick decision, so CODE composites + these helpers are enough.
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

// Run EVERY child (parallel) — each emits to its own intent channel (move + attack + heal coexist in one
// Screeps tick), so no child short-circuits the rest. Returns true if ANY child acted. The composing node
// owns the engaged/clear decision via its own scan + machine edges, so an idle GroupHeal returning true
// here never masks a "room clear" signal.
export function compound(creep, colony, behaviors, ctx) {
  let acted = false;
  for (const behavior of behaviors) {
    if (behavior.run(creep, colony, ctx)) acted = true;
  }
  return acted;
}
