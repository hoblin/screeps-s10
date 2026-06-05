import { Role } from "./Role.js";
import { Miner } from "./Miner.js";
import { Hauler } from "./Hauler.js";
import { Harvester } from "./Harvester.js";
import { Worker } from "./Worker.js";
import { Upgrader } from "./Upgrader.js";
import { Reserver } from "./Reserver.js";
import { RemoteMiner } from "./RemoteMiner.js";
import { RemoteHauler } from "./RemoteHauler.js";
import { RemoteWorker } from "./RemoteWorker.js";
import { Guard } from "./Guard.js";
import { Scout } from "./Scout.js";
import { Escort } from "./Escort.js";
import { Filler } from "./Filler.js";

// ============================================================================
//  Role registry — the one place that maps a creep's role STRING (as stored in
//  creep.memory.role) to its Role CLASS. Lets cross-cutting systems that only
//  hold a creep (e.g. the TrafficManager reading creep.memory.role) reach the
//  role's static declarations — like `movementPriority` — without a central
//  switchboard that re-lists every role. Each role owns its own values.
//
//  ADDING A ROLE — touch these three places:
//    1. Register it in the ROLES map below (role string → class).
//    2. Set its static `movementPriority` per the ladder below (lower wins tile contention).
//    3. Wire an Overlord to spawn/run it in Colony.js (+ its spawn `priority` — see the
//       spawn-priority ladder in Overlord.js).
//
//  MOVEMENT-PRIORITY LADDER (the registry — keep in sync as roles are added):
//    1  miner                            — static income; never pushed off its post
//    2  hauler, harvester, filler        — energy movers (the filler pumps storage→spawn)
//    3  guard, upgrader, worker, remoteHauler — combat / work
//    4  remoteWorker, (Role default)
//    5  remoteMiner, reserver            — remote, yields homeward
//    8  scout                            — roams, yields to everyone
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
  remoteWorker: RemoteWorker,
  guard: Guard,
  scout: Scout,
  escort: Escort,
  filler: Filler,
};

// Resolve a role string to its class, defaulting to the base Role (so an unknown
// or missing role inherits the safe defaults rather than throwing).
export function roleClass(roleName) {
  return ROLES[roleName] || Role;
}
