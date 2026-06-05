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
  assess(room, hostiles = room.find(FIND_HOSTILE_CREEPS)) {
    let threat = 0;
    for (const hostile of hostiles) threat += this.combatPower(hostile);
    const cores = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    });
    if (cores.length) threat += 1;
    return threat;
  },

  // The hostiles' combat PART profile — counts of the parts that decide a fight, so
  // the Guard layer (#118) can pick a rock-paper-scissors counter (kite ranged, rush
  // melee) without live vision, reading it back from intel. Recorded alongside the
  // scalar threat because the deciding creep (the overlord at home) usually has no
  // vision of the contested room when it sizes a guard.
  profile(room, hostiles = room.find(FIND_HOSTILE_CREEPS)) {
    const p = { attack: 0, ranged: 0, heal: 0, tough: 0 };
    for (const hostile of hostiles) {
      p.attack += hostile.getActiveBodyparts(ATTACK);
      p.ranged += hostile.getActiveBodyparts(RANGED_ATTACK);
      p.heal += hostile.getActiveBodyparts(HEAL);
      p.tough += hostile.getActiveBodyparts(TOUGH);
    }
    return p;
  },

  // Record what a creep observes about the room it's standing in. Called for every
  // VISIBLE room each tick (Kernel), so any creep — not just a scout — is a sensor.
  // `tick` is the last-observed time: entries persist (never deleted), so its AGE
  // (Game.time - tick) doubles as a staleness signal a future intelligence overlord
  // (#25) reads to decide which rooms need re-scouting. The part `profile` rides
  // along so the Guard layer can counter what's actually there (#118).
  observe(room) {
    Memory.roomIntel ||= {};
    const prev = Memory.roomIntel[room.name];
    const hostiles = room.find(FIND_HOSTILE_CREEPS); // one scan, shared by both reads
    const threat = this.assess(room, hostiles);
    Memory.roomIntel[room.name] = {
      threat,
      // #150: our own combat power present — lets the economy lens (isHotForEconomy) net
      // a guard-held room to safe. Non-combat creeps (miners/haulers) score 0, so this is
      // effectively the guard/escort force defending the room.
      defense: room.find(FIND_MY_CREEPS).reduce((sum, c) => sum + this.combatPower(c), 0),
      profile: this.profile(room, hostiles),
      tick: Game.time,
      ...this.recon(room),
      // #147 scout-casualty signal: carried across observations (observe overwrites the
      // entry, so it must be re-spread), and RESET when the room is confirmed threat-free
      // — a guard cleared it or the harasser left, so it re-opens to scouting.
      scoutThreat: threat === 0 ? 0 : prev?.scoutThreat || 0,
      scoutThreatTick: threat === 0 ? 0 : prev?.scoutThreatTick || 0,
    };
  },

  // Structural snapshot recorded alongside the threat on every observation (#142): who
  // holds the room, its HOSTILE tower count, and (Season only) any ScoreContainers /
  // ScoreCollectors. One writer, refreshed for free on every visit. Consumers:
  //   • scout priority — staleness + room value (#142)
  //   • retaliation target/route safety — tower-free check (#140)
  //   • score collection — container/collector locations (#24/#48)
  // `towers` counts HOSTILE towers only, so our own room reads 0 (not a danger to us).
  recon(room) {
    const ctrl = room.controller;
    const out = {
      owner: ctrl?.owner?.username || null,
      reserver: ctrl?.reservation?.username || null,
      rcl: ctrl?.level || 0,
      towers: room.find(FIND_HOSTILE_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_TOWER,
      }).length,
    };
    // ScoreContainers/Collectors exist only on the Season server; the same universal
    // bundle also runs on the main shard, so guard the finds (constants undefined there).
    if (typeof FIND_SCORE_CONTAINERS !== "undefined") {
      out.score = room.find(FIND_SCORE_CONTAINERS).map((c) => ({
        x: c.pos.x,
        y: c.pos.y,
        amount: c.store ? c.store[RESOURCE_SCORE] : c.score,
        decay: c.ticksToDecay,
      }));
    }
    if (typeof FIND_SCORE_COLLECTORS !== "undefined") {
      out.collectors = room.find(FIND_SCORE_COLLECTORS).map((c) => ({ x: c.pos.x, y: c.pos.y }));
    }
    return out;
  },

  // Is a room believed dangerous? True only on a FRESH observation with lethal
  // threat. Stale intel (no creep there lately) reads as NOT hot, so the room
  // becomes a target candidate again and gets re-probed — we never strand ourselves
  // avoiding a room that may have cleared while we weren't looking.
  isHot(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    return !!intel && intel.threat > 0 && Game.time - intel.tick <= INTEL_FRESH_TICKS;
  },

  // Is a room unsafe for our ECONOMY right now? (#150) Separate from `isHot`, which drives
  // GUARD DISPATCH — same anti-pattern as the old expansionReady catch-all: two unlike
  // behaviours must not hang off one signal. This nets the room's gross `threat` by our own
  // force present (`defense`): a guard-held *winning* room reads safe, so workers keep
  // mining/hauling/reserving while the guard handles a harasser that bounces in and out — they
  // flee only if our defender dies or leaves (net goes positive). Guard dispatch still reads
  // the GROSS `isHot`/`threatOf`, so it sizes a guard for an uncovered room correctly.
  isHotForEconomy(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return false;
    return intel.threat > (intel.defense || 0);
  },

  // The hostiles' part profile from FRESH intel (or null if stale/unseen) — the read
  // path the Guard layer (#118) uses to pick a counter without live vision.
  profileFor(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return null;
    return intel.profile || null;
  },

  // The fresh scalar threat of a room (or 0 if stale/unseen) — so the Guard layer can
  // compare a candidate guard's power against what it must beat.
  threatOf(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return 0;
    return intel.threat;
  },

  // #147 — record that a scout was hurt or killed in a room. The count grows with repeated
  // casualties (a parked blocker) but is trusted only while FRESH (age < INTEL_FRESH_TICKS):
  // staleness IS the decay, mirroring isHot, so a harasser that leaves fades and the room
  // re-opens to a cheap re-probe. A stale prior count restarts from 0. Both the living-scout
  // hit (Scout) and the death (ScoutOverlord) call this.
  bumpScoutThreat(roomName) {
    Memory.roomIntel ||= {};
    const intel = (Memory.roomIntel[roomName] ||= { threat: 0, profile: {}, tick: Game.time });
    const fresh = intel.scoutThreatTick && Game.time - intel.scoutThreatTick <= INTEL_FRESH_TICKS;
    intel.scoutThreat = (fresh ? intel.scoutThreat || 0 : 0) + 1;
    intel.scoutThreatTick = Game.time;
  },

  // The fresh scout-casualty count for a room (0 if never/stale) — the read path the scout
  // planner deprioritises by, so scouts drain safe space first (#147).
  scoutThreatOf(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || !intel.scoutThreatTick) return 0;
    if (Game.time - intel.scoutThreatTick > INTEL_FRESH_TICKS) return 0;
    return intel.scoutThreat || 0;
  },

  // The full intel entry for a room (or null if never seen) — the read path for the
  // scout planner (#142), which wants the structural fields (owner/towers/score) even
  // when stale; freshness is judged separately via lastSeen.
  intelFor(roomName) {
    return Memory.roomIntel?.[roomName] || null;
  },

  // Game.time of the last observation, or -Infinity if never seen — so a never-seen room
  // sorts as maximally stale for the scout route planner (#142).
  lastSeen(roomName) {
    return Memory.roomIntel?.[roomName]?.tick ?? -Infinity;
  },

  // A room is "winnable" only when a proposed combat BODY out-guns the room's assessed
  // threat by this factor — not merely beats it (#130). A thin margin (50 vs 40) loses to
  // a positioning slip, so require comfortable superiority and otherwise leave the room
  // alone. Shared by GuardOverlord (remote clears) and ScoutOverlord (escort clears).
  WIN_MARGIN: 1.5,

  // Can a guard with `body` clear `roomName` with a comfortable margin? The go/no-go gate
  // both combat consumers use before committing a creep.
  winnable(body, roomName) {
    return this.guardCombatPower(body) >= this.threatOf(roomName) * this.WIN_MARGIN;
  },

  // Lethal power of a proposed guard BODY (a plain part array) — symmetric to
  // combatPower(creep), so the overlord can ask "does the guard I can afford out-gun
  // the room's threat?" before committing one.
  guardCombatPower(body) {
    let power = 0;
    for (const part of body) {
      if (part === ATTACK) power += ATTACK_POWER;
      else if (part === RANGED_ATTACK) power += RANGED_ATTACK_POWER;
    }
    return power;
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
