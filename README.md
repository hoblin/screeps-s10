# screeps-s10

Hoblin's Screeps AI for **Season 10** (10-year anniversary world, Jun 1 → Aug 1 2026).

Clean modern JS (no TypeScript). OOP architecture inspired by **Overmind**:
`Kernel → Colony → Overlord → Role`, with `HiveCluster` for physical sub-systems.

## Architecture

```
Kernel        orchestrator (CPU guard, discovers colonies, drives tick)
 └─ Colony    per-room aggregate; wires clusters + overlords; owns geometry/structure queries
     ├─ HiveCluster   physical infra
     │    └─ Hatchery     spawns+extensions -> fulfils spawn requests
     └─ Overlord  goal manager (owns creeps + one responsibility)
          ├─ MiningOverlord          -> Miner (static, one per source)
          ├─ LogisticsOverlord       -> Hauler (freight-model-sized fleet)
          ├─ WorkOverlord            -> Worker (fill/build/repair)
          ├─ UpgradeOverlord         -> Upgrader (static, on the controller container)
          ├─ DefenseOverlord         -> Towers (no creeps; attack/heal/repair)
          ├─ ReserveOverlord         -> Reserver (remote, CLAIM+MOVE)
          ├─ RemoteMiningOverlord    -> RemoteMiner (remote drop-mining)
          ├─ RemoteLogisticsOverlord -> RemoteHauler (remote -> home haul)
          ├─ ScoutOverlord           -> Scout (map intel + score) + Hunter (solo blocker-clearer)
          ├─ GuardOverlord           -> Guard (clears/denies a contested room; home defence)
          └─ WarbandOverlord         -> Combatant (flag-commanded offence squad)
```

- **Overlord** (base) holds shared spawn-request + creep-iteration logic (DRY).
- **Role** (base) holds the universal gather↔work toggle and energy gathering.
- **Stages** (`src/lib/Stages.js`) — formal stage machine, the single source of
  truth for "what's unlocked". Overlords gate via `stageAtLeast`.
- **RoomHealthCheck** (`src/lib/RoomHealthCheck.js`) — continuous economy signals
  (`saturation`, `energyRich`, `expansionReady`) that drive creep counts and pull
  capabilities (e.g. remote mining) forward of their stage slot. See STRATEGY.md
  "the second axis".
- **TrafficManager** — priority-based tile arbitration; `creep.travelTo` resolves
  in-room moves and delegates the inter-room leg to native `moveTo` (multi-room).
- **BodyGenerator** scales bodies to available energy.
- **prototypes/** install mixins (e.g. `creep.travelTo`) at load.

### Behaviour layer (combat)

Combat creeps carry no hardcoded conduct: each is a **thin state machine** whose role just runs
`BehaviorMachine.run`, with its conduct COMPOSED from a behaviour set in `creep.memory.behaviors`
(`{ default, nodes }`). The overlord steers a unit purely by stamping `memory.target` /
`memory.targetOwner` each tick (the `WarbandOverlord.command` pattern) — no role rewrite needed.

- **`BehaviorMachine`** (`src/behaviors/`) — per-creep node selector: a `default` plus override
  `nodes` with `enteredWhen`/`exitWhen` edges (a fallback/priority selector).
- **Behaviours** (`src/behaviors/combat/`) — composable conduct, contract `run(creep, colony, ctx?) -> bool`:
  `engage` (fight what's here), `holdPoint` (garrison), `holdGround` (#160 post-combat hold),
  `raidRoom` (deny/raze a room), `freeHunter` (roam remotes + kill), `focusFire`, `healGroup`,
  `holdPosition`, `killClosest`, … composed via `fallback`/`sequence` combinators.
- **Atoms** (`src/behaviors/combat/atoms/`) — shared `acts` (execution verbs: `shoot`, `meleeHit`,
  `kiteStep`, `strike`, `travelToRoom`, …) and `selectors` (target policy), plus the magnet
  **potential-field** steering (`field.js`) for close-combat micro.
- **Danger-aware transit** — `travelToRoom` routes via `Routing.towerFreeRoute` (avoid towered and
  unwinnable hot rooms; pass THROUGH a winnable hot room, clearing it in passing), so no mode walks
  blind under a tower or into a losing fight.

## Build

```bash
npm install
npm run build      # esbuild: src/main.js -> dist/main.js
npm run watch      # rebuild on change (local dev)
```

## Deploy (Git Flow + GitHub Actions)

**Single branch, single deploy.** Push to `master` → GitHub Actions builds the
bundle and ships it to the Screeps **`default`** branch on **two servers**:

| Server | URL | Where |
|--------|-----|-------|
| Main (MMO) | `https://screeps.com` | shard2 test bot — `W55S43` |
| Season | `https://screeps.com/season` | Season 10 world — `shardSeason` |

The **same universal bot** runs on both. `.github/workflows/deploy.yml` runs
two steps on every master push:

```yaml
- run: npm run deploy                                            # main server
- run: node deploy.mjs --branch default --server https://screeps.com/season
```

`deploy.mjs` POSTs the built modules straight to `${server}/api/user/code`
(it does NOT use the screeps-api client's `code.set()`, which caches its host
and silently ignored the `--server` override — that bug once left season
empty while reporting `{ok:1}`). Success = server returns `{ok:1}` **and** the
code reads back non-empty.

```bash
# manual local deploy (verifies {ok:1})
SCREEPS_TOKEN=*** npm run deploy                                 # -> main
SCREEPS_TOKEN=*** node deploy.mjs --server https://screeps.com/season  # -> season
```

### One-time setup
1. Add repo secret **`SCREEPS_TOKEN`** — a full-access auth token from
   <https://screeps.com/a/#!/account/auth-tokens> (one token, account `hoblin`,
   works on both servers).
2. The `default` branch exists by default on each server; no manual branch
   creation needed.
3. Push to `master` → CI deploys to both servers automatically.

## Scout pipeline (`bin/`)

Offline tooling to decide **which room to claim**. Scans the whole world once
into a local SQLite mirror, then runs all analysis with zero API calls.

- `scan-season.mjs` — source-count scan of the room grid.
- `geo-season.mjs` — home-room layout geometry for candidates.
- `collect.mjs` — resilient background crawler (gap-fills, 429 backoff); the
  **sole owner of API access**. Mirrors terrain/sources/controller/mineral plus
  the v2 scout fields (keeper lairs, extractor, invader cores, controller
  owner/level/reservation, mineral density, portals, highway deposits/power
  banks) into `tmp/season.db`. Run in tmux: `SCREEPS_TOKEN=*** node bin/collect.mjs --range 31`.
  Rooms scanned before the v2 schema keep those columns NULL — backfill them
  with `node bin/collect.mjs --rescan` (a full ±31 re-crawl, ~840s).
- `db.mjs` — SQLite schema (auto-migrates v1→v2 columns) + `loadRoom(db,name)`
  + single-sourced `parseTerrain`. `SCAN_V` gates the rescan.
- `region-score.mjs` — full economic valuation (terrain-weighted haul cost,
  cross-border remote mining, mineral bonus) plus additive v2 terms with
  documented weights: SK-neighbour value, RCL-scaled enemy penalty,
  reserved-remote discount, choke defensibility, highway access.
  **DB-only, no API** (SOLID: crawler fills the DB, analytics is read-only).
- `heatmap.mjs` — scores the whole grid offline, renders an ANSI heat map with
  per-room feature glyphs + legend, an enriched `tmp/season-heatmap.png` (score
  tint, distinct hues for owned/SK/highway, feature marker dots), and a top-10
  table with neighbour context (SK adjacency, nearest enemy RCL).
- `expansion-map.mjs` — bakes the home room's orthogonal-neighbour map into
  `src/data/expansionMap.json` (the ONE `bin/` output bundled into the bot): safe
  remotes (controller + per-source haul-distance/value + `reservedByOther`), an
  `avoid` list (SK/enemy/invader-core), and an `excluded` audit (why a neighbour was
  dropped). Drives remote mining (#18). Re-run after a re-scan:
  `node bin/expansion-map.mjs --room E15S7`.

> **Standard terrain encoding.** Offline tooling decodes room terrain as the
> standard row-major `terrain[y*50+x]`, matching the engine's `getTerrain().get(x,y)`,
> and uses standard pos-space room adjacency (W/E share the x=0/x=49 edge, N/S the
> y=0/y=49 edge). An earlier "transposed `x*50+y`" belief (#96/#97) was wrong — it
> rested on a false premise (natural objects like the controller/sources CAN sit on
> wall tiles, so "objects land on non-walls" proved nothing); the built spawn and the
> native PathFinder both confirm `y*50+x`. Reverted in #111. **The live bot was never
> affected** — it uses game coords + native pathfinding; only offline analytics decode.

Map is a **±30 square** (`W30..E30 × N30..S30`, ~3721 game rooms). Season 10
spawn was chosen this way: **E15S7**.

## Roadmap
- [x] Hauler role + container mining (LogisticsOverlord, static mining)
- [x] Road planning on hot paths (source↔spawn↔controller)
- [x] Extension placement + auto-build (snowball 300→550 spawn energy)
- [x] Defense overlord + towers (RCL3 auto-placement, attack/heal/repair)
- [x] Season scout pipeline + offline DB analytics & heat map
- [x] Priority traffic layer + multi-room creep movement (`creep.travelTo`)
- [x] Economy-driven creep counts (`RoomHealthCheck`) + freight-model hauler fleet
- [x] Remote mining (reserve + harvest adjacent rooms) — MVP, gated on `expansionReady`
- [ ] Remote-mining refinements (multi-source, self-built remote container)
- [ ] CommandCenter HiveCluster (storage/links/terminal)
- [ ] Labs + boosts, terminal logistics (Stage 4)
- [ ] Score collection fleet (Stage 5 — S10 win condition)
