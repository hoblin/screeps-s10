// ============================================================================
//  Threat — room-threat assessment + intel (#105).
//
//  The flee/avoid decision is driven by a remembered, combat-ASSESSED intel layer,
//  NOT a per-tick "any foreign creep" scan. That fixes two faults of the old
//  `room.find(FIND_HOSTILE_CREEPS).length > 0` trigger: it (a) fled HARMLESS
//  hostiles — a lone enemy scout zeroed our whole remote income — and (b) had no
//  memory, so a creep re-approached the instant it was home → border oscillation.
//
//  Every creep is a sensor: a Kernel pass over `Game.rooms` (we have vision of a
//  room iff one of our creeps is in it, or we own it) refreshes the intel each tick.
//  A sibling's observation thus protects creeps that haven't even arrived, and a
//  room we've left reverts to "unknown" after the freshness window so we re-probe
//  instead of avoiding a room that may have cleared — no dedicated scout needed yet.
//
//  The static expansion map (#88) answers "is this remote SAFE by economy/terrain";
//  this is the live overlay answering "is it safe RIGHT NOW". Target selection
//  (Colony.remoteTarget) reads both. The classifier here is also the substrate the
//  later warrior/intelligence roles (#25) will read to decide where to send a fighter.
// ============================================================================

// How long a threat observation is trusted before the room reverts to "unknown" and
// becomes a re-probe candidate. ~a chunk of a creep lifetime: long enough that we
// don't re-feed creeps into a genuinely-held room every few ticks, short enough that
// a transient scout's contest clears within a reasonable window. Tunable.
const INTEL_FRESH_TICKS = 1000;

export const Threat = {
  // Lethal combat capability of a hostile creep — parts that can damage OUR creeps.
  // A MOVE-only scout, a CLAIM reserver, a CARRY/WORK economy creep all score 0:
  // harmless, so we keep working rather than abandon the room to them.
  combatPower(creep) {
    return (
      creep.getActiveBodyparts(ATTACK) * ATTACK_POWER +
      creep.getActiveBodyparts(RANGED_ATTACK) * RANGED_ATTACK_POWER
    );
  },

  // A room's current threat: the summed lethal power of the hostiles present, plus a
  // flat danger for a hostile invader core (it spawns attackers even before any are
  // visible). 0 == safe to work in. Source-Keeper rooms are already excluded by the
  // static map, so they never reach a remote overlord.
  assess(room) {
    let threat = 0;
    for (const hostile of room.find(FIND_HOSTILE_CREEPS)) threat += this.combatPower(hostile);
    const cores = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    });
    if (cores.length) threat += 1;
    return threat;
  },

  // Record what a creep observes about the room it's standing in. Called for every
  // VISIBLE room each tick (Kernel), so any creep — not just a scout — is a sensor.
  // `tick` is the last-observed time: entries persist (never deleted), so its AGE
  // (Game.time - tick) doubles as a staleness signal a future intelligence overlord
  // (#25) reads to decide which rooms need re-scouting.
  observe(room) {
    Memory.roomIntel ||= {};
    Memory.roomIntel[room.name] = { threat: this.assess(room), tick: Game.time };
  },

  // Is a room believed dangerous? True only on a FRESH observation with lethal
  // threat. Stale intel (no creep there lately) reads as NOT hot, so the room
  // becomes a target candidate again and gets re-probed — we never strand ourselves
  // avoiding a room that may have cleared while we weren't looking.
  isHot(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    return !!intel && intel.threat > 0 && Game.time - intel.tick <= INTEL_FRESH_TICKS;
  },

  // Forget intel for rooms unseen for far longer than the freshness window, so the
  // overlay can't grow without bound over a long season. Called periodically (not
  // every tick) by the Kernel; `maxAge` ≫ INTEL_FRESH_TICKS so it never drops intel
  // that still informs a decision — only long-abandoned rooms, which we'd re-observe
  // anyway if we returned.
  prune(maxAge) {
    const intel = Memory.roomIntel;
    if (!intel) return;
    for (const room in intel) {
      if (Game.time - intel[room].tick > maxAge) delete intel[room];
    }
  },
};
