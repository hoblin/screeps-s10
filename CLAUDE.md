# CLAUDE.md — screeps-s10

Hoblin's Screeps AI for **Season 10** (10-year anniversary world, Jun 1 → Aug 1 2026).
Clean modern JS (no TypeScript), bundled with esbuild and uploaded to Screeps.

## Read these first
- **`README.md`** — architecture overview (`Kernel → Colony → Overlord → Role`, `HiveCluster` for physical infra).
- **`STRATEGY.md`** — the game plan: the stage-machine doctrine ("prepare ahead, don't firefight"), per-stage triggers (Stage 1 Bootstrap → 2 StaticMining → 2b Hauling → 3 Storage&Links → 4 Industry → 5 Endgame), and the architecture roadmap. **Every gameplay/feature decision must be justified against STRATEGY.md.**

## Architecture in one breath
- `Kernel` drives the tick (CPU guard, discovers colonies). `Colony` is the per-room aggregate that wires `HiveCluster`s + `Overlord`s.
- **Overlord** = a goal manager owning creeps + ONE responsibility. It decides spawn requests (`generateSpawnRequest`) and runs its creeps (`run`). Stage-gated via `stageAtLeast(colony, "2b:Hauling")` from `src/lib/Stages.js`.
- **Role** = stateless behaviour: `Role.run(creep, colony)`, static methods only. Shared helpers live on `Role` / in `src/roles/`.
- **HiveCluster** = physical sub-system (e.g. `Hatchery` = spawns+extensions). Overmind-inspired.
- **Stages** (`src/lib/Stages.js`) = formal state machine. Each stage: `enteredWhen` (entry trigger), `provides`, `readyForNextWhen` (advance trigger). Gate new logic on the stage that should activate it — don't run it before its trigger.
- Container lifecycle pattern lives in `MiningOverlord` (`computeMiningPosition` / `ensureContainerSite` / `walkableTilesAround`, cached in `Memory.colonyData[colony.name]`). **Mirror or extract-and-share this pattern — don't copy-paste it.**

## Build / deploy
- `npm run build` — esbuild bundle → `dist/main.js`. MUST compile cleanly before any PR.
- `npm run watch` — rebuild on change. `npm run deploy` — upload to Screeps (`deploy.mjs`).
- No test framework and no real linter yet (`npm run lint` is a stub). Verify by building + reasoning through edge cases; keep functions small and pure where possible.
- Bundle must be **ASCII-safe** (esbuild `charset:ascii`) — non-BMP emoji break the Screeps upload (learned the hard way: PRs #2/#3).

## Deploy pipeline — ONLY master deploys
`push to master → GitHub Actions (.github/workflows, on: push: branches:[master]) → npm run build → npm run deploy → Screeps default branch`.
Feature branches NEVER touch the live game until their PR merges to master.

## Git flow (strict)
- **One issue = one PR.** Branch per ticket: `feat/<issue>-<short-desc>` (e.g. `feat/27-controller-container`). Conventional Commits (`feat:`/`fix:`/`chore:`/`docs:`).
- Always branch from a **freshly pulled master** (`git checkout master && git fetch origin --prune && git pull --ff-only`). A merged PR does NOT update local master until you fetch.
- Open PRs as **draft** while iterating; mark ready (`gh pr ready`) only when build is clean and self-review is done. Merge is the human's click. NO direct pushes to master. No amend/force-push on shared branches.
- No AI/Claude attribution in commit messages.

## Live bot (read-only checks)
Room **W55S43, shard2**, account `hoblin`. State via REST (NOT `execute_command`, which runs in the default-shard context and can mis-target shard2):
`curl -s "https://screeps.com/api/game/room-objects?room=W55S43&shard=shard2" -H "X-Token: $SCREEPS_TOKEN"`.
Manual in-game `createConstructionSite` is a DIAGNOSTIC PROBE only — it dies with the test room. The deliverable is always CODE that auto-builds/recovers on a fresh room at tick 0 (Season 10 = brand-new room).

## Conventions
- Boy Scout Rule: leave code cleaner than you found it. Favour small, focused, well-named functions; document non-obvious game mechanics in comments.
- Match surrounding style exactly (ES-module imports, static role methods, overlord class methods). No unrelated refactors in a feature PR.
- Respect Screeps caps (5 containers/room, 100 construction sites global) — log non-OK API results, never throw on them.
