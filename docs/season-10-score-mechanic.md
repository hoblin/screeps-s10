# Season 10 — Score Mechanic (research report)

**Confidence: CONFIRMED LIVE.** Verified three ways: the live `shardSeason`
runtime (constants + `Score` prototype), the official Steam 10th-anniversary
announcement, and a **live pickup test** (a `[MOVE]` probe walked onto a 9710-point
Score in E15S7 — it vanished the same tick the creep occupied the tile; see
"Live confirmation" below).

> Canonical reference for how we win S10. `STRATEGY.md` Stage 5 links here instead
> of duplicating it.

## TL;DR

**Score objects spawn on the ground in any room. A creep banks the points by
simply standing on the tile** — no structure, no carry, no action. The win is
**map-wide reach**: be present in (or able to dash into) the most rooms and grab
each `Score` before it decays or a rival reaches it first. Pure logistics of
*creep-to-tile time*, not economy-to-collector distance.

## The mechanic: ground pickup by tile occupation

1. A **`Score`** object appears on a random walkable tile, in **any room
   map-wide** (chance `SCORE_SPAWN_CHANCE` per `SCORE_SPAWN_INTERVAL_TICKS`),
   carrying a fixed `score` amount and a decay timer.
2. **A creep moves onto that tile.** That's it — the engine banks the `score` to
   your season total automatically and the object disappears.
3. If no one reaches it before `ticksToDecay` hits 0, it decays and is lost.
   Multiple players race for the same tile; **first creep onto it wins**.

There is **no** intermediate resource, structure, or intent:
- `Creep.harvest` rejects a `Score` target (`ERR_INVALID_TARGET` — it only accepts
  Source/Mineral/Deposit).
- `Creep.pickup` rejects it (only accepts `Energy` objects).
- The `Score` prototype has **no** collect/withdraw/transfer method.
- Collection is positional, handled server-side on tile entry — your code only has
  to path a creep onto the tile.

## The `Score` object (live API)

`room.find(FIND_SCORES)` → `Score` objects. A bare `RoomObject` with:

| Property | Meaning |
|----------|---------|
| `score` | integer points banked when collected |
| `decayTime` | game tick at which it decays |
| `ticksToDecay` | `decayTime - Game.time` |
| `pos` / `id` / `room` | standard RoomObject fields |

**No `store`.** `LOOK_SCORE` (`"score"`) finds it via `pos.lookFor`.

## Constants (live `shardSeason`, confirmed)

| Constant | Value | Meaning |
|----------|-------|---------|
| `FIND_SCORES` | `10031` | locate Score objects in a room |
| `LOOK_SCORE` | `'score'` | look-type for Score |
| `SCORE_SPAWN_CHANCE` | `0.01` | per-interval spawn chance |
| `SCORE_SPAWN_INTERVAL_TICKS` | `250` | spawn cadence |

**NOT present** (these are Season **1**, not S10): `RESOURCE_SCORE`,
`FIND_SCORE_CONTAINERS`/`FIND_SCORE_COLLECTORS`, `ScoreContainer`/`ScoreCollector`
structures, `WALLS_RADIUS`, `SCORE_COLLECTOR_SINK`/`_MAX_CAPACITY`. There are **no
score structures and no highway collector hubs** — the earlier "bank at walled
highway collectors" model was wrong (Season-1 carryover) and is fully retracted.

## What a score creep needs

- **`MOVE` only.** No `CARRY` (nothing to carry), no `WORK` (no harvest). Speed to
  tile is the entire job; a pure `[MOVE]` creep moves 1 tile/tick on any terrain
  (zero fatigue with no other parts).
- A target picker: among known `Score` objects, prefer **highest `score` reachable
  before `ticksToDecay`** (value ÷ travel time), de-conflicting with rivals.
- **Vision to spot them.** A Score is only actionable in a room we can see, so the
  scout/intel layer (`Threat.recon` → `FIND_SCORES`) feeds the collector targets.

## Live confirmation (E15S7, shardSeason, tick ~63500)

- Found one `Score` at `(31,32)`, `score: 9710`, `ticksToDecay: 4352`.
- Spawned a `[MOVE]` probe (`role:"scoreprobe"`, an unclaimed role the bot ignores)
  and drove it via console `moveTo(31,32)`.
- The moment it occupied `(31,32)`, `room.find(FIND_SCORES).length` went `1 → 0`.
  Probe then suicided (cleanup).
- **Incidental yield:** with NO score logic in the bot, the account already sat at
  **rank 26 / score 815238** for season 2026-06 — economy creeps wandering over
  Score tiles. A dedicated collector is clearly high-value.

## Start / map rules

- **CPU = constant 100** for everyone. Free entry (no access keys).
- Start **GCL1 / GPL0**, empty.
- `shardSeason` ≈ 2628 playable rooms. **Map:** ±30 square (W30..E30 × N30..S30);
  corners out-of-borders.

## Our position (E15S7, shardSeason)

- Sources `(42,26)` + `(17,27)`, controller `(16,30)`, mineral **K**, spawn near
  `(19,35)` (HoSpawn). RCL 5 as of this report.
- **SK neighbour E15S6** (above): 4 keeperLairs + 3 sources — fat late-game remote.
- Score spawns in **our own room and our remotes too**, so the first collection
  ground is rooms we already occupy — no travel to highways required.

## Strategic implications (drives win-condition design)

- **Economy-only room scoring is fine.** No "distance to highway collector" term is
  needed — Score is everywhere. This dissolves the old #48 premise.
- The win-condition layer is **coverage × speed**: maximise the number of rooms we
  have vision in (scouts) and the speed/number of fast `[MOVE]` collectors that can
  reach a fresh Score before decay or a rival.
- Score in **our own + reserved/remote rooms is nearly free** (we're already there,
  it's defended) — grab those first. Contested neutral/highway rooms are bonus reach
  for a fast collector once the home pipeline is saturated.

## Downstream work

- **`Threat.recon` bug:** records score under a non-existent `FIND_SCORE_CONTAINERS`
  guard (always false) → score never recorded. Fix to `FIND_SCORES` (store
  `{x,y,score,ticksToDecay}`) so the intel layer feeds collectors.
- **#24 — Score collection fleet:** re-scoped to a `ScoreOverlord` + `scorer` role
  (`[MOVE]`) that paths to the best-value reachable `Score` from intel. No
  dismantle/deposit pipeline.
- **#48 — Scoring v3:** the highway-collector-distance term is retracted; re-scope
  to whatever still adds value (e.g. weighting rooms by observed Score spawn rate),
  or close if economy scoring already suffices.
