// ============================================================================
//  Overlord — base class for every goal-oriented manager in the colony.
//
//  An Overlord owns exactly ONE responsibility (mining a source, upgrading the
//  controller, building...) and does three things:
//    1. Declares how many creeps (and what body) it wants  -> spawn requests
//    2. Claims the creeps that belong to it                -> assignedCreeps
//    3. Drives those creeps every tick                     -> runCreep(creep)
//
//  Creep ownership model (Overmind-style):
//  -----------------------------------------------------------------------------
//  Every creep carries TWO identity tags in memory:
//    creep.memory.role     -> what KIND of worker it is ("miner", "hauler"...)
//    creep.memory.overlord -> WHICH overlord instance owns it ("miner:<sourceId>")
//
//  Matching by role alone is fine when there is one overlord per role. But for
//  per-source mining we run MANY MiningOverlords (one per source), all using the
//  role "miner". The `overlord` tag is what tells them apart, so each overlord
//  only ever drives its own creeps and only spawns to fill its own quota.
//
//  Subclasses override the four hooks below. Everything else (spawn-request
//  generation, per-creep iteration) is shared here — the DRY backbone.
// ============================================================================
export class Overlord {
  /**
   * @param {Colony} colony   - the colony this overlord serves
   * @param {object} options
   * @param {number} options.priority    - lower number = spawned earlier
   * @param {string} options.instanceId  - unique suffix so two overlords of the
   *                                        same role don't fight over creeps.
   *                                        Omit for singleton overlords (one per
   *                                        role); the role name alone is enough.
   *
   * SPAWN-PRIORITY LADDER (lowest number first; the Hatchery fulfils the highest-priority
   * request it can afford; each overlord documents its own rank). Current ladder:
   *   1 Mining/Defense · 2 Work/Scout/Filler · 3 Logistics · 4 Upgrade/Guard ·
   *   5 Reserve/RemoteMining/RemoteWork/RemoteLogistics.
   * New overlord: pick a tier, set it in super(colony, { priority }).
   */
  constructor(colony, { priority = 5, instanceId = null } = {}) {
    this.colony = colony;
    this.room = colony.room;
    this.priority = priority;
    this.instanceId = instanceId;
  }

  // ---- hooks for subclasses to override ------------------------------------

  /** Primary role name — used for the default spawn body/memory and the identifier. */
  get role() {
    throw new Error("Overlord subclass must define get role()");
  }

  /**
   * Every role this overlord owns. Defaults to just the primary role, so a normal
   * single-role overlord is unchanged. A controller that drives a SET of roles for one
   * task (e.g. ScoutOverlord owning "scout" + an optional "hunter") overrides this to
   * list them all; `assignedCreeps` then claims creeps across the whole set and
   * `runCreep` dispatches by `creep.memory.role`.
   */
  get roles() {
    return [this.role];
  }

  /** How many creeps this overlord wants alive. */
  desiredCount() {
    return 0;
  }

  /** Body array to request, given the spawn energy budget available. */
  bodyFor(_energyBudget) {
    return [WORK, CARRY, MOVE];
  }

  /** Per-creep behaviour, called once per tick for each assigned creep. */
  runCreep(_creep) {}

  // ---- creep ownership -----------------------------------------------------

  /**
   * A stable identity string written into each creep's memory.overlord so we
   * can re-claim our creeps after a global reset. Singleton overlords (no
   * instanceId) just use their role; per-instance overlords append their id.
   */
  get identifier() {
    return this.instanceId ? `${this.role}:${this.instanceId}` : this.role;
  }

  /**
   * The living creeps that belong to THIS overlord.
   *  - Singleton overlords claim every creep of their role.
   *  - Per-instance overlords claim only creeps tagged with their identifier.
   */
  get assignedCreeps() {
    const creeps = this.roles.flatMap((role) => this.colony.creepsWithRole(role));
    if (!this.instanceId) return creeps;
    return creeps.filter((creep) => creep.memory.overlord === this.identifier);
  }

  // ---- shared machinery ----------------------------------------------------

  /**
   * Emit a spawn request when we have fewer creeps than we want.
   * Returns null when we're already at full headcount.
   */
  generateSpawnRequest() {
    const currentCount = this.assignedCreeps.length;
    const targetCount = this.desiredCount();
    if (currentCount >= targetCount) return null;

    // Recovery-aware (#54): the colony sizes bodies to spendable energy while
    // clawing back from a workforce collapse, else to the full spawn capacity.
    const energyBudget = this.colony.spawnEnergyBudget();
    return {
      priority: this.priority,
      role: this.role,
      body: this.bodyFor(energyBudget),
      memory: {
        role: this.role,
        colony: this.colony.name,
        overlord: this.identifier, // stamp ownership at birth
      },
    };
  }

  /** Drive every creep this overlord owns (skipping ones still spawning). */
  run() {
    for (const creep of this.assignedCreeps) {
      if (creep.spawning) continue;
      this.runCreep(creep);
    }
  }
}
