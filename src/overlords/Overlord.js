// ============================================================================
//  Overlord — base class for all goal-oriented managers.
//  An Overlord owns ONE responsibility (mining, upgrading, building...) and:
//   - reports how many creeps of which body it wants (init -> spawn request)
//   - drives the creeps assigned to it each tick (run)
//
//  Subclasses override:
//   - get role()            -> string role name its creeps carry
//   - desiredCount()        -> how many creeps it wants
//   - bodyFor(energy)       -> body array given available spawn energy
//   - runCreep(creep)       -> per-creep behaviour
//
//  This is the DRY backbone: shared spawn-request + iteration logic lives here.
// ============================================================================
export class Overlord {
  constructor(colony, priority = 5) {
    this.colony = colony;
    this.room = colony.room;
    this.priority = priority; // lower = spawned first
  }

  // ---- to be overridden ----------------------------------------------------
  get role() {
    throw new Error("Overlord subclass must define get role()");
  }
  desiredCount() {
    return 0;
  }
  bodyFor(_energyAvailable) {
    return [WORK, CARRY, MOVE];
  }
  runCreep(_creep) {}

  // ---- shared machinery ----------------------------------------------------
  get creeps() {
    return this.colony.creepsWithRole(this.role);
  }

  // Produce a spawn request if we are below desired headcount.
  init() {
    const have = this.creeps.length;
    const want = this.desiredCount();
    if (have >= want) return null;

    const energy = this.room.energyCapacityAvailable;
    return {
      priority: this.priority,
      role: this.role,
      body: this.bodyFor(energy),
      memory: { role: this.role, colony: this.colony.name },
    };
  }

  run() {
    for (const creep of this.creeps) {
      if (creep.spawning) continue;
      this.runCreep(creep);
    }
  }
}
