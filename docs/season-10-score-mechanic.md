# Season 10 — Score Mechanic (research report)

**Confidence: HIGH.** Confirmed by the docs-season API constants, the Rust
binding (`seasonal-season-1`), and the official Steam announcement. Season 10 is
the **"Score"** family (same as Season 1) — **not** symbols/decoders (S2), and
**not** Thorium/reactors.

> This is the canonical reference for how we win S10. `STRATEGY.md` Stage 5 links
> here instead of duplicating it. Numbers flagged "recheck live" are confirmed
> only after the first tick (20:00 EEST, Jun 3 2026).

## TL;DR

Points are banked at **ScoreCollectors that live in highway rooms** — not in your
own room. The win is `strong economy × short, defensible distance to a nearby
highway collector hub`. Our economy-only room scoring under-weighted this; see
the geographic implication below.

## The mechanic: ScoreContainer → carry → ScoreCollector

1. **`ScoreContainer`** spawns **randomly map-wide** (chance `0.01` per
   `250` ticks), holding `RESOURCE_SCORE` (`'score'`).
2. A creep **withdraws / picks up** the score.
3. The creep **`transfer`s** it to a **`ScoreCollector`** → leaderboard points,
   **per unit of score** (not scaled by RCL).

## Constants (docs-season.screeps.com/api)

| Constant | Value | Meaning |
|----------|-------|---------|
| `RESOURCE_SCORE` | `'score'` | the carried resource |
| `FIND_SCORE_CONTAINERS` | `10011` | locate score containers |
| `FIND_SCORE_COLLECTORS` | `10012` | locate collectors |
| `WALLS_RADIUS` | `5` | collectors are walled in radius-5 — **must dismantle to reach** |
| `SCORE_CONTAINER_SPAWN_CHANCE` | `0.01` | per-interval spawn chance |
| `SCORE_CONTAINER_SPAWN_INTERVAL_TICKS` | `250` | spawn cadence |
| `SCORE_COLLECTOR_SINK` | `20` | score/tick intake (recheck: max-intake vs drain-if-below-threshold) |
| `SCORE_COLLECTOR_MAX_CAPACITY` | `20000` | collector cap |

## Structures unique to S10

- `RESOURCE_SCORE` — the carried resource.
- **`ScoreContainer`** — spawns in random rooms map-wide, holds score.
- **`ScoreCollector`** — lives in **highway rooms**, **walled radius-5**, cap 20k,
  sink 20/tick.
- **NOT present:** decoders/symbols, Thorium/reactors, caravans.

## Start / map rules

- **CPU = constant 100** for everyone. Free entry (no access keys).
- Start **GCL1 / GPL0**, empty (the Season-1 pattern).
- `shardSeason` ≈ 2628 playable rooms, ≈ 139 users (as of Jun 3 morning).
- **Map:** ±30 square (W30..E30 × N30..S30, ≈3721 grid / ≈2628 playable). Corners
  are out-of-borders.
- **First real tick:** ≈20:00 EEST, Jun 3 2026 — score structures appear at start.

## 🎯 Geographic implication (drives room scoring)

- **ScoreCollectors live in HIGHWAY rooms** (`x%10==0 || y%10==0` — sector borders
  and intersections). Score is **banked at highways, NOT in your own room**;
  containers roam map-wide.
- **Best claim** = strong economy **+ short, defensible distance** to a nearby
  highway collector hub. Proximity to a highway **intersection**
  (`x%10==0 && y%10==0`, where collectors cluster) is prime — multiple banking
  targets, harder for one enemy to lock down. Expect fights over collectors.
- ⚠️ **Our spawn E15S7 was scored on ECONOMY ONLY.** E15/S7 are not highways;
  nearest highways are E10/E20 (x-line) and S0/S10 (y-line), several rooms away.
  The economy-only scoring likely mis-prioritised — this is exactly what
  **#48 (Scoring v3)** addresses (distance-to-collector-hub as a win-condition
  term).

## Our position (E15S7, shardSeason)

- Sources `(42,26)` + `(17,27)`, controller `(16,30)`, mineral **K**, spawn `(15,26)`.
- **SK neighbour E15S6** (directly above): 4 keeperLairs + 3 sources + mineral +
  extractor — a fat late-game remote once we can clear keepers.

## Open unknowns — recheck live after 20:00

1. **Exact score amount per container** (API gives chance/interval, not magnitude).
2. **Collector placement density** — 1/sector? per intersection? Scan
   `FIND_SCORE_COLLECTORS` live.
3. **`SINK 20` semantics** — max intake, or drain-if-below-threshold? Test by
   depositing and watching `store`.
4. **Respawn / sector-wall layout** — `Game.map.getRoomStatus` once spawned.
5. **Container distribution** — all rooms vs non-highway only.

## Downstream work

- **#48 — Scoring v3:** add "distance to highway ScoreCollector hub" as a
  first-class win-condition term (the geographic implication above).
- **#24 — Score collection fleet:** `ScoutOverlord` finds containers + collectors;
  `ScoreOverlord` runs the harvest → dismantle-walls → deposit pipeline,
  combat-ready (collectors are contested).
