// ============================================================================
//  HiveCluster — base class for physical sub-systems of a Colony.
//  (Overmind term.) Examples: Hatchery (spawns+extensions), CommandCenter
//  (storage+terminal+links). A HiveCluster wraps a cluster of structures and
//  exposes high-level operations the Colony/Overlords can call.
// ============================================================================
export class HiveCluster {
  constructor(colony) {
    this.colony = colony;
    this.room = colony.room;
  }

  run(_input) {
    // override
  }
}
