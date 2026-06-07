# Strategy — Screeps S10

Living strategy doc. Stages of the game, what to prioritize at each, and how our
architecture grows to support it. Inspired by Overmind (bencbartlett) and the
jonwinsley Field Journal game plan.

> **Where we are now (update this line as we grow):** E15S7, **RCL 3, Stage
> 2b:Hauling**, climbing to RCL 4. Economy self-running and net-positive. Remote
> mining is **live** (pulled forward of its Stage-3 slot by the `expansionReady`
> signal — see "the second axis" below).

## Core principle (the whole game in one line)

**Maximize energy throughput from sources → controller/score, minimizing waste.**
Every stage is just removing the current bottleneck in that pipeline.

## How we think about stages (the "prepare ahead" doctrine)

We do NOT ask "what does the colony need right now?" — that's reactive, always
firing late. Instead each stage is a **formal contract** (see `src/lib/Stages.js`,
the single source of truth):

- **enter trigger** — the condition that means we're IN this stage
- **provides** — the capabilities this stage turns on
- **next trigger** — the condition that will promote us to the next stage

Because we know the *next* stage and its trigger, we write its logic in advance.
The code exists and waits; the trigger flips it on automatically (e.g. the hauler
overlord requests 0 haulers until a source container is finished, then scales up
the instant that trigger fires). The colony walks its own roadmap instead of
stumbling into each phase. Dashboard reads the same machine, so telemetry shows
the current stage AND whether we're `READY` for the next one.

- A Source yields **3000 energy / 300 ticks = 10 energy/tick**. Tapping it fully
  needs **5 WORK parts** on a miner (5×2 = 10/tick).
- Wasted energy = source sitting full, or creeps walking instead of working.
- The bottleneck moves over time: bodies → logistics → infrastructure → expansion.

## The second axis: health signals (when the economy can *afford* it)

Stages answer **what** is unlocked — coarse, monotonic milestones gated on RCL /
structures. But "unlocked" ≠ "affordable": a freshly-RCL-4 room *can* build Storage,
and a struggling one *can* technically send a reserver, but shouldn't. So a second
control axis runs alongside the stage machine — `RoomHealthCheck`
(`src/lib/RoomHealthCheck.js`), which reads continuous economic **dynamics** and
exposes boolean signals overlords gate on (all EWMA-smoothed + Schmitt-latched so
they don't chatter):

- **`saturation`** — how close source output is to being fully tapped + hauled.
- **`energyRich`** — sustained surplus. Goes false once healthy logistics *consumes*
  the surplus, so it is NOT a "do we have spare capacity" signal.
- **`expansionReady`** — spare **spawn** capacity (smoothed spawn-idle ratio,
  crisis-gated: off during downgrade/attack/can't-afford-a-reserver). Idle spawn time
  is the currency a remote creep costs. Self-throttling: spawning remote creeps lowers
  idle → the latch releases.

Two consequences for doctrine:

1. **Creep counts are driven by economy, not flat constants** (#81). The hauler fleet
   is sized by a **freight-turnover model** (#84): `N = ceil(2·Σ(r·d)·margin / (C·v))`
   — feed-forward from production, so energy is moved before it piles on the ground
   (a threshold/PID only reacts *after* it's already there). Each derived value lives
   on the class that owns its domain (SOLID): roles own body/production/capacity, the
   Colony owns geometry/structures, overlords only orchestrate.
2. **Capabilities can be pulled FORWARD of their stage slot.** Remote mining lives in
   Stage 3 on paper, but it activates on `expansionReady`, not on reaching RCL 4 — on
   E15S7 it switched on at RCL 3 the instant the spawn had idle capacity to spare. The
   stage says a capability is *available*; the health signal says the economy can
   *afford* it now. "Prepare ahead" + "spend only spare capacity."

---

## Stage 0 — Founding (a claimed colony with no spawn yet)

**Only a 2nd+ colony ever sees this.** The home colony's first spawn is placed manually at game
start, so it begins at Stage 1 — that assumption was baked silently into the whole machine. But a
colony we **claim** (#220) starts with a controller and nothing else: no spawn, no creeps, no energy.
Stage 0 is the formal contract for that state:

- **enter trigger:** the room is ours but `spawns.length === 0`.
- **provides:** the first spawn — the `Hatchery` places its construction site (`SpawnPlanner`, computed
  live from terrain) and **pioneers** from the main colony build it. **Nothing else** runs: source
  containers and static miners are gated off (useless without a spawn, and placing them early just
  steals the pioneers' build effort from the spawn — the container-before-spawn bug, #228).
- **next trigger:** `spawns.length > 0` → Stage 1. The instant the spawn stands, the colony spawns its
  own workers and bootstraps normally.

This is now the absolute floor for an owned room (the role Stage 1's old `() => true` enter trigger
played). `Recovery` still preempts it, but a fresh RCL 0/1 room never trips `recovering` (its
"developed" guard). The single predicate `stageAtLeast("1:Bootstrap")` = "past Founding / has a spawn"
is what every pre-spawn-suppressed behaviour keys on.

## Stage 1 — Bootstrap (RCL 1)

**Goal:** get the economy self-sustaining; rush RCL 2.
- Generic `harvester`/`worker` creeps (mine + haul + upgrade in one body). Fine while tiny.
- Single objective: pump energy into the controller to hit **RCL 2**.
- Don't over-optimize RCL 1–3 (common newbie trap — wasted effort).

**Architecture today:** Kernel → Colony → Overlords (Mining/Work/Upgrade) → Roles. ✅ working.

## Stage 2 — Static mining (RCL 2–3)

**Goal:** specialize. Stop walking miners back and forth.
- **RCL 2** unlocks 5 Extensions (300→550 spawn energy) + Containers.
- Switch to **static miners**: 5 WORK + 1 MOVE, parked on a Container next to each source.
- **Haulers** (CARRY+MOVE) move energy container→spawn/controller. Specialization > generalists.
- Build **Container under controller** + **roads** on hot paths (source↔spawn↔controller).
- Rush the **first Tower** (RCL 3) for cheap defense, then relax.

**Architecture add:** miner role becomes static (✅ done). Split into two triggers:

### Stage 2a — Static mining (trigger: RCL≥2 or a container exists)
- Per-source `MiningOverlord` ✅, static `Miner` ✅, container placement ✅.
- **Next trigger:** a source container is FINISHED.

### Stage 2b — Hauling (trigger: source container finished)
- `LogisticsOverlord` + `Hauler` role: container → spawn/extensions → tower →
  controller-container → storage. Activates ONLY on the trigger above; before it,
  workers self-serve and 0 haulers spawn.
- **Controller container:** `UpgradeOverlord` plans a container **two tiles short
  of the controller** on the source→controller approach (shared `ContainerPlanner`
  geometry — the source case hugs its anchor, this one offsets so the hauler drops
  off at the edge of the upgrader cluster, not its centre) and keeps its site
  alive. Haulers fill it (deliver priority 3); upgraders park on/beside it,
  withdrawing at range 1 and upgrading the controller at range 3 — the
  static-miner trick, inverted, turning the upgrader into a near-zero-walk static
  upgrader. The RCL-5 controller link later replaces hauler delivery to this same
  parking spot (link→link, zero hauling).
- **Roads on hot paths:** the `Hatchery` (base anchor) plans roads along each
  source↔spawn and spawn↔controller route via the shared `RoadPlanner`, after
  extensions so the layout weaves through the final base shape. Roads halve move
  cost (1 fatigue vs 2/10), so hauler round trips shorten and bodies need fewer
  MOVE parts. Built below extensions, above repair; queued in waves to spare the
  global 100-site cap.
- **Hauler fleet sizing:** count comes from the freight-turnover model driven by
  `RoomHealthCheck` (see "the second axis"), not one-hauler-per-source — sized
  feed-forward to production so energy never piles up.
- **Next trigger:** Storage exists (RCL 4) → Stage 3.

A `MiningSite` HiveCluster (source + container + link) is the Overmind pattern.

## Stage 3 — Storage & links (RCL 4–5)

**Goal:** decouple production from consumption; go fast.
- **RCL 4 = Storage.** Central energy buffer — the heart of mid-game logistics.
- **RCL 5 = Links.** Teleport energy (source link → storage link → controller link),
  cutting hauler distance massively. Huge throughput unlock.
- Dedicated **upgrader(s)** parked at controller link, just pumping.
- **Remote mining — SHIPPED (MVP), gated on `expansionReady`, not the stage** (#18).
  An offline generator (`bin/expansion-map.mjs`, #88) bakes a static neighbour map
  (`src/data/expansionMap.json`): safe remotes with per-source haul distance + value,
  an `avoid` list (SK/enemy rooms), and an `excluded` audit. The bot reads
  `expansionMap[colony.name]`; `Colony.remoteTarget()`/`remoteSource()` pick the ONE
  shared target. `ReserveOverlord`→`Reserver` (CLAIM+MOVE) holds the reservation
  (boosts the source to 3000/300); `RemoteMiningOverlord`→`RemoteMiner` drop-mines a
  remote source; `RemoteLogisticsOverlord`→`RemoteHauler` (freight-model fleet over
  the long haul) carries it home. **Prerequisite:** multi-room movement (#92) —
  `travelTo` delegates the inter-room leg to native `moveTo`, then the per-room
  resolver resumes. v1 mines ONE source of the top target, drop-mined.
  **Refinements open:** multi-source / per-source overlords (we currently ignore a
  higher-value E15S8 source), self-built remote container (stop ground decay).

**Architecture add:** `ReserveOverlord` + `RemoteMiningOverlord` +
`RemoteLogisticsOverlord` ✅ done. Still TODO: the `CommandCenter`/`LinkNetwork`
HiveCluster (storage + links) — the remaining Stage-3 infra (#16 Storage, #17 Links).

## Stage 4 — Industry (RCL 6–7)

**Goal:** minerals, boosts, scale.
- **RCL 6:** Extractor + Terminal + Labs. Mine the room's mineral (ours = **K, 35000@(45,18)**).
- **Terminal:** S10 — sends only to OWN terminals (no market!). Internal logistics only.
- **Labs:** react minerals → boosts (stronger creeps for less body).
- **RCL 7:** 2nd spawn, more extensions. Spawn throughput stops being a bottleneck.

**Architecture add:** `EvolutionChamber`/`Lab` HiveCluster, boost management in Overlords.

## Stage 5 — Season 10 score (the win condition, open from tick 0)

**Goal:** maximise banked SCORE — the season win condition. NOT RCL8-gated; score is
collectible the moment scouts are roaming.
- **Season 10 win = SCORE** (confirmed live). Mechanic + constants documented in full at
  [`docs/season-10-score-mechanic.md`](docs/season-10-score-mechanic.md) — read it before
  touching score work. In short: `Score` objects spawn on the ground in **any room**
  (uniformly map-wide); a creep banks the points by simply **occupying the tile** — no
  structure, carry, or action. They decay if uncollected; first creep to the tile wins.
- **The score fleet IS the scout fleet** (#24): scouts already roam the map for vision and
  are fast `[MOVE]` creeps — exactly what a score creep is. When `Threat.recon` records a
  ground Score (`roomIntel[room].score`), the `ScoutOverlord` diverts the closest free
  scout to step on it, then it resumes its route. No separate collector role, no
  deposit/dismantle pipeline (that was the wrong Season-1 model, retracted).
- **Win = coverage × speed.** More scouts + more spawns (RCL7→2, RCL8→3) and ultimately
  more colonies → more of the map seen and more Score reached before decay/rivals. Scale
  the scout fleet from early on, not as an RCL8 afterthought.
- RCL8 still matters for the ECONOMY that funds the fleet (controller caps at **15
  energy/tick** upgrade; surplus funds more scouts/spawns/colonies). 100 CPU flat for
  everyone → algorithm quality wins, not wallet; spend CPU on good pathfinding freely.

**Architecture:** the `ScoutOverlord` owns score collection (scout diversion, #24) — no
separate `ScoreOverlord`. Score location confers no geographic claim advantage (uniform
spawn), so region scoring stays economy-based (#48 retracted).

---

## Architecture roadmap (how the OOP grows)

We follow Overmind's evolution. Current vs. target:

| Concept | Now | Target (Overmind-style) |
|---|---|---|
| Creep logic | Roles (static) | Roles OK early; Overmind later folded logic into Overlords |
| Goal management | Overlords (1 responsibility each) ✅ | + priority queue on an **Overseer** |
| Economic control | `RoomHealthCheck` signals drive counts + pull capabilities forward (#81/#84/#89) ✅ | richer feed-forward signals; a `LogisticsNetwork` request/provide queue |
| Movement | priority traffic layer + multi-room transit (#55–#67, #92) ✅ | path caching / resolver polish (#57) |
| Conditional reactions | none | **Directives** — placed by Overseer to react to stimuli (invaders, expansion, score) (#25) |
| Physical systems | HiveCluster (Hatchery) ✅ | + MiningSite, `CommandCenter`/LinkNetwork, EvolutionChamber |
| Logistics | freight-turnover-sized hauler fleet (#84) ✅ | dedicated `LogisticsNetwork` (request/provide queue) |

**Directives** are the big missing idea: conditional Overlords that auto-spawn in
response to game state (NPC invasion → DefenseDirective; score appears →
ScoreDirective). Overseer scans rooms each tick and places/removes them.

## Priorities right now (current frontier)

Stages 1 → 2b are shipped (static mining, freight-sized haulers, controller
container, roads, RCL-3 tower). Economy is self-running on E15S7 (RCL 3, climbing to
4) and remote mining is live and net-positive. The open frontier:

1. **#18 remote-mining refinements** — multi-source / per-source overlords (mine the
   better E15S8 source we currently ignore), self-built remote container.
2. **Stage 3 infra (prepare ahead for RCL 4):** #16 Storage, then #17 Links.
3. **Robustness bugs:** #54 emergency self-harvest, #63 workers abandon when clustered.
4. **#111 (done):** reverted the offline tooling to standard `y*50+x` terrain +
   standard adjacency (the "transposed-coord" belief was false); resolves #97.
5. **Architecture:** #25 Directives layer, once a 2nd directive (defense/score) appears.

## Sources
- Overmind: https://github.com/bencbartlett/Overmind + design blog series (bencbartlett.com/blog)
- Game plan: https://www.jonwinsley.com/notes/screeps-game-plan
- Screeps docs: https://docs.screeps.com/control.html
- RCL table: https://wiki.screepspl.us/index.php/Room_Control_Level
