# Strategy — Screeps S10

Living strategy doc. Stages of the game, what to prioritize at each, and how our
architecture grows to support it. Inspired by Overmind (bencbartlett) and the
jonwinsley Field Journal game plan.

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

---

## Stage 1 — Bootstrap (RCL 1, where we are now)

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
- **Controller container:** `UpgradeOverlord` plans a container hugging the
  controller (shared `ContainerPlanner` geometry with the source containers) and
  keeps its site alive. Haulers fill it (deliver priority 3); upgraders park
  beside it and pull from range 1 — the static-miner trick, inverted, turning the
  upgrader into a near-zero-walk static upgrader. The RCL-5 controller link later
  replaces hauler delivery to this same parking spot (link→link, zero hauling).
- **Roads on hot paths:** the `Hatchery` (base anchor) plans roads along each
  source↔spawn and spawn↔controller route via the shared `RoadPlanner`, after
  extensions so the layout weaves through the final base shape. Roads halve move
  cost (1 fatigue vs 2/10), so hauler round trips shorten and bodies need fewer
  MOVE parts. Built below extensions, above repair; queued in waves to spare the
  global 100-site cap.
- **Next trigger:** Storage exists (RCL 4) → Stage 3.

A `MiningSite` HiveCluster (source + container + link) is the Overmind pattern.

## Stage 3 — Storage & links (RCL 4–5)

**Goal:** decouple production from consumption; go fast.
- **RCL 4 = Storage.** Central energy buffer — the heart of mid-game logistics.
- **RCL 5 = Links.** Teleport energy (source link → storage link → controller link),
  cutting hauler distance massively. Huge throughput unlock.
- Dedicated **upgrader(s)** parked at controller link, just pumping.
- Start **remote mining**: reserve adjacent rooms (CLAIM creep), haul energy home.
  No GCL needed to reserve; reserving boosts a source to 3000/300.

**Architecture add:** `LinkNetwork` HiveCluster, `RemoteMiningOverlord` + `ReserveOverlord`.

## Stage 4 — Industry (RCL 6–7)

**Goal:** minerals, boosts, scale.
- **RCL 6:** Extractor + Terminal + Labs. Mine the room's mineral (ours = **K, 35000@(45,18)**).
- **Terminal:** S10 — sends only to OWN terminals (no market!). Internal logistics only.
- **Labs:** react minerals → boosts (stronger creeps for less body).
- **RCL 7:** 2nd spawn, more extensions. Spawn throughput stops being a bottleneck.

**Architecture add:** `EvolutionChamber`/`Lab` HiveCluster, boost management in Overlords.

## Stage 5 — Endgame (RCL 8) & Season 10 score

**Goal:** RCL 8 capped — pivot CPU/energy to the actual win condition.
- RCL 8 controller caps at **15 energy/tick** upgrade (more only via Power Creeps).
- **Season 10 win = SCORE.** Score items spawn periodically in ALL rooms. Collect by
  moving a creep onto them. Most score wins.
- Endgame surplus energy/CPU → **score collection fleet**: fast scouts + collectors
  roaming for score, hauling it to deposit points (per S10 mechanics).
- 100 CPU flat for everyone → algorithm quality wins, not wallet. Spend CPU on good
  pathfinding/planning freely.

**Architecture add:** `ScoutOverlord` (find score), `ScoreOverlord` (collect/deliver).
This is the season-specific layer — the real objective once economy is mature.

---

## Architecture roadmap (how the OOP grows)

We follow Overmind's evolution. Current vs. target:

| Concept | Now | Target (Overmind-style) |
|---|---|---|
| Creep logic | Roles (static) | Roles OK early; Overmind later folded logic into Overlords |
| Goal management | Overlords (1 responsibility each) ✅ | + priority queue on an **Overseer** |
| Conditional reactions | none | **Directives** — placed by Overseer to react to stimuli (invaders, expansion, score) |
| Physical systems | HiveCluster (Hatchery) ✅ | + MiningSite, LinkNetwork, EvolutionChamber |
| Logistics | per-role hauling | dedicated `LogisticsNetwork` (request/provide queue) |

**Directives** are the big missing idea: conditional Overlords that auto-spawn in
response to game state (NPC invasion → DefenseDirective; score appears →
ScoreDirective). Overseer scans rooms each tick and places/removes them.

## Priorities right now (next concrete steps)
1. ✅ Bootstrap economy (done — 2 creeps, cycle closed)
2. Hit RCL 2, add Extensions to spawn-fill logic
3. Static miners + haulers (kill the walking-miner waste)
4. Container/road infrastructure on hot paths
5. Storage at RCL 4 → the pivot point to "real" mid-game

## Sources
- Overmind: https://github.com/bencbartlett/Overmind + design blog series (bencbartlett.com/blog)
- Game plan: https://www.jonwinsley.com/notes/screeps-game-plan
- Screeps docs: https://docs.screeps.com/control.html
- RCL table: https://wiki.screepspl.us/index.php/Room_Control_Level
