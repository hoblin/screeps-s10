import { stageAtLeast } from "../lib/Stages.js";
import { actionIcon } from "../lib/Icons.js";

// ============================================================================
//  Role — base behaviour shared by all creep roles (the DRY core).
//  Roles are stateless behaviour objects: we call Role.run(creep, colony).
//  We use static methods so there's no per-creep allocation each tick.
//
//  Shared helpers handle the universal "gather energy <-> do work" state
//  toggle that almost every economic creep needs.
// ============================================================================
export class Role {
  // Movement priority for the traffic resolver (TrafficManager): LOWER number =
  // more important = wins a contested tile, the same convention as spawn
  // priority. This base value is the idle/unknown rank — a role that doesn't
  // override it is freely shovable. Subclasses override to claim a higher rank,
  // and a future Behavior (#39) can override per-creep on top of that. The
  // ordering encodes the economy's critical path: logistics (miner/hauler)
  // outranks work, work outranks idling, so a creep that physically moves energy
  // is never walled in by a consumer. (Full ladder + new-role checklist: roles/index.js.)
  static movementPriority = 4;

  // #145 — danger-aware pathing policy. Default false: home/combat creeps path straight
  // (a guard must APPROACH the threat, not detour around it). Non-combat creeps that
  // traverse contested space (scouts, remote economy) set this true so travelTo weights
  // hostile ranged kill-zones costly and routes around them (see lib/Movement.js).
  static avoidHostiles = false;

  // Movement priority while merely GATHERING/PARKING (empty) — the LOWEST rank of
  // all (below the idle baseline), so an empty creep fetching energy or waiting
  // by a container never pushes one that's actively carrying energy to its job.
  // gatherEnergy runs only when working===false, so it stamps this on every move
  // it makes; working moves keep the role's movementPriority. Resolved via `this`
  // so a subclass can override it (same role-owned spirit as movementPriority).
  // (Observed live: empty workers parking pushed active builders out of reach.)
  static gatherMovementPriority = 5;

  // Debug breadcrumb (#103): stamp a short intent tag for THIS tick at a role's
  // decision branch ("haul:withdraw", "deliver:spawn", "rhaul:to-room"…). The
  // Kernel's per-tick pass folds it — with the creep's FINAL position + working
  // state — into a capped rolling log in `creep.memory.log`, so a creep's recent
  // behaviour is one `get_memory` read away instead of a multi-tick API trace.
  // Last write per tick wins; the pass consumes it, so a tick with no note() just
  // records position + state. Cheap and side-effect-free beyond the one memory key.
  static note(creep, action) {
    creep.memory._act = action;
    // Push view (#123): show what the creep is doing as an in-game speech bubble,
    // driven off the same tag the trace records. Only on a SWITCH (#126) — say when
    // the icon changes, not every tick, so the room UI isn't a wall of bubbles.
    const icon = actionIcon(action);
    if (icon && creep.memory._icon !== icon) {
      creep.say(icon);
      creep.memory._icon = icon;
    }
  }

  // Send a creep with no valid assignment home to be recycled — reclaiming part of
  // its body cost instead of letting it idle until it dies. Used when a remote creep
  // is ORPHANED: e.g. a deploy that changed the overlord set leaves an old creep with
  // a stale `memory.overlord` and no stamped target (no overlord drives it). It walks
  // to a spawn and recycles. NOT for a temporary retreat (hot room) — that creep must
  // come back when the room cools, so those callers use their own retreatHome.
  static recycleAtHome(creep, colony) {
    const spawn = colony.spawns[0];
    if (!spawn) return;
    this.note(creep, "recycle");
    if (creep.pos.isNearTo(spawn)) spawn.recycleCreep(creep);
    else creep.travelTo(spawn, { range: 1 });
  }

  // Toggle creep.memory.working between gathering and spending energy.
  // Returns true if the creep should be DOING WORK (spending), false if gathering.
  static updateWorkingState(creep) {
    const m = creep.memory;
    // No say() here — the per-action icons from note() (#123) cover the mode switch
    // with finer detail (e.g. work:gather 📥 → work:build 🔨).
    if (m.working && creep.store[RESOURCE_ENERGY] === 0) m.working = false;
    if (!m.working && creep.store.getFreeCapacity() === 0) m.working = true;
    return m.working;
  }

  // Gather energy from the cheapest available source: dropped > container/storage > harvest.
  //
  // Direct self-harvest (step 3) is the early-game lifeline that keeps the
  // controller from downgrading before any container exists — but it becomes
  // HARMFUL once hauling is active (2b:Hauling+): a worker/upgrader on a source
  // steals the static miner's spot and double-walks energy the haulers already
  // move. So from 2b on the economy is strictly miner → container → hauler →
  // consumer, and self-harvest is forbidden. Pass `colony` so we can check the
  // stage; without it we assume early game and keep the fallback (the safe
  // default — a missing colony must never let the controller downgrade).
  static gatherEnergy(creep, colony) {
    // Everything here is empty-state repositioning (gatherEnergy runs only while
    // working===false), so every move drops to the gather priority — an empty
    // creep must yield to one actively carrying energy to its job. See #58.
    // `this` is the calling role class (callers use this.gatherEnergy), so a
    // subclass override of gatherMovementPriority is honoured.
    const move = (target) => creep.travelTo(target, { priority: this.gatherMovementPriority });

    // A source container is reserved for the hauler ONLY while a hauler is alive
    // AND able to drain it — that's who we must not out-compete. A hauler still
    // spawning can't withdraw yet, so it doesn't count: reserving on its behalf
    // would re-lock the source container for its whole ~spawn window, starving
    // the very #37 recovery that's trying to fund it. With no drain-capable
    // hauler (pre-2b self-serve, or the emergency where the fleet has died) the
    // pipeline is broken and survival outranks the no-racing rule: workers/
    // upgraders may drain source containers directly, else a colony whose last
    // hauler dies right after a spawn can't refill and spirals out.
    //
    // The same survival logic applies while any container is still UNDER
    // CONSTRUCTION (#74). At 2b entry the controller container isn't built yet
    // (nor is storage), so haulers have no delivered-energy endpoint to fill and
    // workers/upgraders have none to draw from — they can't harvest directly
    // (gated off below at 2b) and the source containers are reserved, so the very
    // workers who must BUILD that container can't fund it. Deadlock. While a
    // container site exists the pipeline is incomplete, so lift the reservation
    // and let them self-serve until those containers finish.
    // Only scan for container sites once we know a hauler can actually drain —
    // with no drain-capable hauler the reservation is already off, so the scan
    // would be wasted work (gatherEnergy runs every tick for every empty creep).
    const haulerCanDrain =
      colony && colony.creepsWithRole("hauler").some((h) => !h.spawning);
    const unbuiltContainers =
      haulerCanDrain &&
      colony.room.find(FIND_MY_CONSTRUCTION_SITES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length > 0;
    const reserveSourceContainers = haulerCanDrain && !unbuiltContainers;

    // In RECOVERY the normal pipeline is dead (containers/storage drained), so let a worker ALSO drain a
    // LINK to bootstrap the spawn back — links are off-limits in normal play (they feed the controller/
    // storage net), but a collapsed colony needs every reachable joule (#282). Off outside recovery → zero
    // blast radius. A drainable store = a container/storage (or a link only while recovering) with energy
    // that isn't a hauler-reserved source container.
    const drainLinks = !!(colony && colony.health.recovering);
    const isDrainableStore = (s) =>
      (s.structureType === STRUCTURE_CONTAINER ||
        s.structureType === STRUCTURE_STORAGE ||
        (drainLinks && s.structureType === STRUCTURE_LINK)) &&
      s.store[RESOURCE_ENERGY] > 0 &&
      !(reserveSourceContainers && Role.isSourceContainer(s, colony));

    // 1+2. The committed PICKUP: dropped energy, else a container/storage with energy (a source
    //    container excluded while a hauler owns it — the miner→container→hauler→consumer pipeline,
    //    fair game only in the #37 emergency / #74 unbuilt-container window when reserveSourceContainers
    //    is false). LATCHED via committedTarget (#243): commit to ONE source until it's drained instead
    //    of re-picking the closest-with-energy every tick. The old per-tick re-pick flipped between the
    //    two source containers as their miners refilled them → travelTo repathed → a stampede (haulers
    //    never glitched because they latch their pickup, #86). Selection is ignoreCreeps (#63): a cluster
    //    of creeps between us and the target can't hide it (findClosestByPath treats creeps as walls by
    //    default → null → "nothing to gather"); travelTo routes around them.
    //    isValid rechecks the reservation EACH TICK against the freshly-computed reserveSourceContainers,
    //    so a committed source container releases the instant a hauler spawns (or the container drains) —
    //    the #37/#52/#74 invariants stay tick-fresh, never frozen into a stale latch.
    const pickup = this.committedTarget(
      creep,
      "gatherTarget",
      (t) =>
        t.amount != null
          ? t.amount > 0 // a dropped pile — finish it once committed, even below the 50 start threshold
          : isDrainableStore(t), // tick-fresh: a committed link releases the instant recovery clears
      () => {
        const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
          ignoreCreeps: true,
          filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
        });
        if (dropped) return dropped;
        return creep.pos.findClosestByPath(FIND_STRUCTURES, { ignoreCreeps: true, filter: isDrainableStore });
      }
    );
    if (pickup) {
      const result =
        pickup.amount != null ? creep.pickup(pickup) : creep.withdraw(pickup, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) move(pickup);
      return;
    }

    // 3. Last resort BEFORE hauling: harvest a source directly (keeps the controller alive while
    //    infrastructure is built). ignoreCreeps selection (#63) — pick the source, travelTo routes around.
    if (!colony || !stageAtLeast(colony, "2b:Hauling")) {
      const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE, { ignoreCreeps: true });
      if (source) {
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) move(source);
      }
      return;
    }

    // 4. Hauling is active but nothing is drainable this tick. Park beside the nearest eligible
    //    container and wait for it to refill. Source containers excluded while a hauler owns them (idling
    //    on one would let us snatch energy the instant a miner drops it — the starvation we avoid);
    //    the #37 emergency lifts that. ignoreCreeps selection (#63).
    const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      ignoreCreeps: true,
      filter: (s) =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        !(reserveSourceContainers && Role.isSourceContainer(s, colony)),
    });
    if (container && !creep.pos.inRangeTo(container, 1)) move(container);
  }

  // Is this structure a SOURCE container — a STRUCTURE_CONTAINER a static miner
  // sits on/fills, i.e. within range 1 of a source? The hauler is its sole
  // legitimate consumer; every other role must steer clear so the miner →
  // container → hauler → consumer pipeline doesn't stall. The container-type
  // guard matters: callers pass storage too (it's a valid pickup), and a storage
  // that happens to sit beside a source is NOT a source container — only drop-
  // mined containers are. Lives on the base Role so workers, upgraders and the
  // Hauler share one definition (Hauler.isSourceContainer resolves here via
  // static inheritance). Returns false without a colony — pre-colony there are
  // no source containers to avoid.
  static isSourceContainer(container, colony) {
    if (!colony || container.structureType !== STRUCTURE_CONTAINER) return false;
    return colony.sources.some((source) => source.pos.getRangeTo(container.pos) <= 1);
  }

  // Commit to a target across ticks (the anti-rotation latch, generalised from Hauler.committedPickup).
  // Returns the object cached under `creep.memory[key]` while it's still VALID per `isValid`; otherwise
  // (re)picks via `find` (a fresh, ignoreCreeps selection), caches its id, and returns it (null if none).
  // This is what keeps a worker from re-selecting — and so travelTo from re-pathing — every tick while it
  // heads to a still-valid target: it sticks to the chosen one until that target is satisfied or gone.
  static committedTarget(creep, key, isValid, find) {
    const id = creep.memory[key];
    const cached = id ? Game.getObjectById(id) : null;
    if (cached && isValid(cached)) return cached;
    const picked = find();
    creep.memory[key] = picked ? picked.id : null;
    return picked;
  }
}
