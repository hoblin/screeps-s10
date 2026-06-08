import { RemoteMission } from "./RemoteMission.js";
import { Threat } from "../lib/Threat.js";

const FLAG_PREFIX = "warband"; // a flag whose name starts with this is the visual objective lever
const DEFAULT_TAG = "alpha"; // the squad tag healGroup/groupAnchor coordinate a multi-unit raid through

// The raider behaviour set: raid the objective room (raidRoom — hunts the targetOwner en route, razes the
// economy when the room is creep-clear), fight back when jumped (selfDefense), focus-fire the priority
// hostile (focusFire). Conduct lives in these behaviours; the mission only stamps the set + steering.
const RAID_BEHAVIORS = { default: "raidRoom", nodes: ["selfDefense", "focusFire"] };

// ============================================================================
//  RaidMission (#259, slice 3) — a human-commanded OFFENSIVE: muster a group at home, deploy, and raid /
//  deny a chosen room (optionally hunting a named owner en route). It is the FIRST mission fielded by the
//  MANUAL activation source, but it is NOT a "manual-only" type — it is named for its CONDUCT (raid), a
//  RemoteMission like any other; the manual warband is just its current activator (the second axis: TYPE ×
//  SOURCE). The same compose → spawn → lead spine drives it past the entry point — the only difference is
//  `fromOrder` reads a human order instead of Threat intel.
//
//  Order (Memory.warband, or a `warband*` flag for the objective): `{ objective:{roomName,x,y}, composition?,
//  targetOwner?, tag?, colony? }` — the exact shape `bin/sapi warband go/set` writes; a flag supplies only
//  the objective. composition supplied → honoured as the roster; omitted → auto-derived from the threat profile (the
//  shared counterRoster), so the manual and autonomous paths are identical. Muster-once falls out of the
//  RemoteMission lifecycle (assemble at home, deploy as one, no mid-flight replacement) — no special latch.
//  Identity is the SQUAD TAG, not the room, so moving the objective RE-TASKS the same live group rather than
//  orphaning it (the "move the flag, the warband follows" lever).
// ============================================================================
export class RaidMission extends RemoteMission {
  // The MANUAL source factory: build the raid for the ONE host colony, or [] (no order / not the host).
  static fromOrder(colony) {
    const order = this.order();
    if (!order) return [];
    if (colony.name !== this.hostColony(order)) return []; // #235: one global order musters ONE colony
    return [new RaidMission(colony, order)];
  }

  // The active objective, flag winning over Memory (drop the flag to fall back to the memory coords; clear
  // both to stand down). Returns the full order, or null when neither lever is set.
  static order() {
    const flag = Object.values(Game.flags).find((f) => f.name.startsWith(FLAG_PREFIX));
    const mem = Memory.warband || {};
    let objective = null;
    if (flag) objective = { roomName: flag.pos.roomName, x: flag.pos.x, y: flag.pos.y };
    else if (mem.objective?.roomName) {
      objective = { roomName: mem.objective.roomName, x: mem.objective.x ?? 25, y: mem.objective.y ?? 25 };
    }
    if (!objective) return null;
    return {
      objective,
      targetOwner: mem.targetOwner || null,
      tag: mem.tag || DEFAULT_TAG,
      composition: mem.composition || null,
      colony: mem.colony || null,
    };
  }

  // Which colony hosts a global order (#235): the explicitly named one, else the strongest-affordable — the
  // colony with the highest spawn-energy capacity fields the biggest force. One host, never a pile-on.
  static hostColony(order) {
    if (order.colony) return order.colony;
    // Only colonies that can actually MUSTER it — a spawnless owned room (a destroyed/under-construction
    // spawn) with high energy capacity must not "host" an order it can never field.
    const owned = Object.values(Game.rooms).filter((r) => r.controller?.my && r.find(FIND_MY_SPAWNS).length);
    if (!owned.length) return null;
    return owned.reduce((best, r) => (r.energyCapacityAvailable > best.energyCapacityAvailable ? r : best)).name;
  }

  constructor(colony, order) {
    super(colony, order.objective.roomName);
    this.type = "raid";
    this.point = order.objective; // {roomName, x, y} — the hold/raze tile, stamped per tick
    this.targetOwner = order.targetOwner; // username raidRoom hunts en route, or null
    this.tag = order.tag;
    this.composition = order.composition; // a supplied roster, or null → auto-derive
  }

  // Squad-tag identity (NOT the room) so re-aiming the objective keeps the same group, members and all.
  get key() {
    return `${this.type}:${this.tag}`;
  }

  // Supplied composition honoured as the roster; omitted (or malformed) → a threat-derived offensive counter
  // (the shared sizer, with the raider behaviour set). An undefended target → a single cheap raider (threatOf
  // 0 → count 1).
  roster() {
    return this.validComposition() ? this.composition : this.counterRoster(Threat.profileFor(this.room), RAID_BEHAVIORS);
  }

  // Memory.warband.composition is hand-written, untrusted input — only honour it if it's a well-formed roster
  // (an array of { body:[], count:number, behaviors.default }). Anything malformed falls back to the
  // auto-derived counter rather than throwing in the overlord's generateSpawnRequest and crashing the tick.
  validComposition() {
    return (
      Array.isArray(this.composition) &&
      this.composition.length > 0 &&
      this.composition.every(
        (s) => s && Array.isArray(s.body) && typeof s.count === "number" && s.behaviors?.default
      )
    );
  }

  // Steer the group: the RemoteMission lifecycle sets target (objective room once launched, else home), and
  // the raid adds the objective point + the owner-hunt key for raidRoom (the command() steering, now owned
  // by the mission). The objective stands while the mission is active, so these are always stamped; the
  // overlord clears them on stand-down when the order is withdrawn.
  drive(members) {
    super.drive(members);
    for (const creep of members) {
      creep.memory.point = this.point;
      creep.memory.targetOwner = this.targetOwner;
    }
  }
}
