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
import { Hunter } from "./Hunter.js";
import { Filler } from "./Filler.js";
import { Combatant } from "./Combatant.js";
import { Claimer } from "./Claimer.js";
import { Pioneer } from "./Pioneer.js";

// ============================================================================
//  Role registry — the one place that maps a creep's role STRING (as stored in
//  creep.memory.role) to its Role CLASS. Lets cross-cutting systems that only
//  hold a creep (e.g. the TrafficManager reading creep.memory.role) reach the
//  role's static declarations — like `movementPriority` — without a central
//  switchboard that re-lists every role. Each role owns its own values.
//
//  ADDING A ROLE — touch these three places:
//    1. Register it in the ROLES map below (role string → class).
//    2. Set its static `movementPriority` (lower wins tile contention; each role documents
//       its own rank). Current ladder: 1 miner · 2 hauler/harvester/filler ·
//       3 guard/combatant/upgrader/worker/remoteHauler/pioneer · 4 remoteWorker/(default) ·
//       5 remoteMiner/reserver/claimer · 8 scout. Also set `static avoidHostiles = true` if it's
//       a non-combat creep that traverses contested space (#145 — routes around kill-zones).
//    3. Wire an Overlord to spawn/run it in Colony.js (+ its spawn `priority` — ladder in
//       Overlord.js).
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
  hunter: Hunter, // solo blocker-clearer → freeHunter (#187), a thin BehaviorMachine role (ScoutOverlord)
  filler: Filler,
  combatant: Combatant, // generic warband creep — conduct from its memory.behaviors set (#39)
  claimer: Claimer, // CLAIM creep that takes a designated 2nd colony (#220, ClaimOverlord)
  pioneer: Pioneer, // WORK/CARRY/MOVE seed that bootstraps the new colony's first spawn (#220)
};

// Resolve a role string to its class, defaulting to the base Role (so an unknown
// or missing role inherits the safe defaults rather than throwing).
export function roleClass(roleName) {
  return ROLES[roleName] || Role;
}
