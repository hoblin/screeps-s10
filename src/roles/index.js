import { Role } from "./Role.js";
import { Miner } from "./Miner.js";
import { Hauler } from "./Hauler.js";
import { Harvester } from "./Harvester.js";
import { Worker } from "./Worker.js";
import { Upgrader } from "./Upgrader.js";
import { Reserver } from "./Reserver.js";
import { RemoteMiner } from "./RemoteMiner.js";
import { RemoteHauler } from "./RemoteHauler.js";

// ============================================================================
//  Role registry — the one place that maps a creep's role STRING (as stored in
//  creep.memory.role) to its Role CLASS. Lets cross-cutting systems that only
//  hold a creep (e.g. the TrafficManager reading creep.memory.role) reach the
//  role's static declarations — like `movementPriority` — without a central
//  switchboard that re-lists every role. Each role owns its own values.
// ============================================================================
export const ROLES = {
  miner: Miner,
  hauler: Hauler,
  harvester: Harvester,
  worker: Worker,
  upgrader: Upgrader,
  reserver: Reserver,
  remoteMiner: RemoteMiner,
  remoteHauler: RemoteHauler,
};

// Resolve a role string to its class, defaulting to the base Role (so an unknown
// or missing role inherits the safe defaults rather than throwing).
export function roleClass(roleName) {
  return ROLES[roleName] || Role;
}
