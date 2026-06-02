# screeps-s10

Hoblin's Screeps AI for **Season 10** (10-year anniversary world, Jun 1 → Aug 1 2026).

Clean modern JS (no TypeScript). OOP architecture inspired by **Overmind**:
`Kernel → Colony → Overlord → Role`, with `HiveCluster` for physical sub-systems.

## Architecture

```
Kernel        orchestrator (CPU guard, discovers colonies, drives tick)
 └─ Colony    per-room aggregate; wires clusters + overlords
     ├─ HiveCluster   physical infra
     │    └─ Hatchery     spawns+extensions -> fulfils spawn requests
     └─ Overlord  goal manager (owns creeps + one responsibility)
          ├─ MiningOverlord    -> Harvester
          ├─ WorkOverlord      -> Worker (fill/build/repair)
          ├─ UpgradeOverlord   -> Upgrader
          └─ DefenseOverlord   -> Towers (no creeps; attack/heal/repair)
```

- **Overlord** (base) holds shared spawn-request + creep-iteration logic (DRY).
- **Role** (base) holds the universal gather↔work toggle and energy gathering.
- **BodyGenerator** scales bodies to available energy.
- **prototypes/** install mixins (e.g. `creep.travelTo`) at load.

## Build

```bash
npm install
npm run build      # esbuild: src/main.js -> dist/main.js
npm run watch      # rebuild on change (local dev)
```

## Deploy (Git Flow + GitHub Actions)

- `develop` → Screeps **develop** branch (sandbox)
- `master`  → Screeps **default** branch (prod / Season 10)

Uses [`kskitek/screeps-pusher`](https://github.com/kskitek/screeps-pusher).

### One-time setup
1. Add repo secret **`SCREEPS_TOKEN`** — a full-access auth token from
   <https://screeps.com/a/#!/account/auth-tokens>.
2. In Screeps, **create the `develop` and `default` branches manually**
   (the pusher does not auto-create branches).
3. Push to `develop` to deploy to sandbox; merge to `master` for prod.

## Roadmap
- [ ] Hauler role + container mining (decouple mine/haul)
- [ ] Custom Traveler pathing in `creep.travelTo`
- [ ] CommandCenter HiveCluster (storage/links/terminal)
- [x] Defense overlord + towers (RCL3 auto-placement, attack/heal/repair)
- [ ] Port logic from old `Hob-screepers` (Overlord-era reference)
