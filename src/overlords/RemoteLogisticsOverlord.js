import { Overlord } from "./Overlord.js";
import { RemoteHauler } from "../roles/RemoteHauler.js";
import { Hauler } from "../roles/Hauler.js";
import { Miner } from "../roles/Miner.js";

// ============================================================================
//  RemoteLogisticsOverlord — hauls the remote target source home (#18, C2).
//
//  Singleton, health-gated like RemoteMiningOverlord. Sizes the hauler fleet with
//  the SAME freight-turnover model as the home logistics (#84), just over the long
//  remote haul: N = ceil( 2·r·d·margin / (C·v) ), where r is the remote source's
//  output (≈ what our miner extracts), d is the one-way path from home (from the
//  static map), C the hauler capacity. Long hauls need several haulers — that's
//  the real cost of remoting a far room, and expansionReady self-throttles it so
//  it never spawns beyond our spare spawn capacity.
// ============================================================================
const HAULER_SPEED = 1; // tiles/tick on roads/plains for a 1:1 CARRY:MOVE body
const FREIGHT_MARGIN = 1.3; // same headroom as the home freight model (#84)

export class RemoteLogisticsOverlord extends Overlord {
  constructor(colony) {
    super(colony, { priority: 5 }); // after the home economy
  }

  get role() {
    return "remoteHauler";
  }

  desiredCount() {
    if (!this.colony.health.expansionReady) return 0;
    const s = this.colony.remoteSource();
    if (!s || !isFinite(s.dist)) return 0;
    const cap = this.colony.room.energyCapacityAvailable;
    const carry = Hauler.capacityAt(cap);
    if (!carry) return 0;
    const rate = Miner.harvestRateAt(cap); // energy/tick the remote miner produces
    return Math.max(1, Math.ceil((2 * rate * s.dist * FREIGHT_MARGIN) / (carry * HAULER_SPEED)));
  }

  bodyFor(energyBudget) {
    return RemoteHauler.bodyFor(energyBudget);
  }

  // Stamp the target room + source tile so haulers know where to pick up.
  generateSpawnRequest() {
    const request = super.generateSpawnRequest();
    if (!request) return null;
    const s = this.colony.remoteSource();
    if (!s) return null;
    request.memory.targetRoom = s.room;
    request.memory.sourcePos = { x: s.x, y: s.y };
    return request;
  }

  runCreep(creep) {
    RemoteHauler.run(creep, this.colony);
  }
}
