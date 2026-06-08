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
export const INTEL_FRESH_TICKS = 1000;

export const Threat = {
  // Lethal combat capability of a hostile creep — its boost-aware effective damage/tick (ATTACK + RANGED,
  // each × its boost). A MOVE-only scout, a CLAIM reserver, a CARRY/WORK economy creep all score 0:
  // harmless, so we keep working rather than abandon the room to them. The SINGLE source of per-creep
  // offence — assess/threatOf and the group model both read it, so a boosted attacker is never under-rated
  // on the offence term (#268).
  combatPower(creep) {
    return this.creepCombat(creep).damage;
  },

  // Boost multiplier on a body part for its OWN combat effect (1× when unboosted) — read straight from the
  // engine's native BOOSTS table, so new boost tiers need no maintenance here (convention over config). This
  // only reads what the ENEMY is already boosted with, to size correctly against a boosted force; choosing
  // OUR own boosts is a later doctrine (#250).
  boostMult(part) {
    if (!part.boost) return 1;
    const effect = BOOSTS[part.type]?.[part.boost];
    return effect ? effect.attack || effect.rangedAttack || effect.heal || 1 : 1;
  },

  // A hostile's EFFECTIVE combat output, boost-aware: damage/tick (ATTACK + RANGED, each × its boost) and
  // heal/tick (HEAL × its boost), plus the part split so the group model can flag a DEDICATED healer. Reads
  // live body (boost lives per-part), so it needs vision — the group totals are snapshotted into intel.
  creepCombat(creep) {
    let damage = 0;
    let heal = 0;
    let attack = 0;
    let ranged = 0;
    let healParts = 0;
    for (const part of creep.body) {
      if (part.hits === 0) continue; // a destroyed part is inactive
      const mult = this.boostMult(part);
      if (part.type === ATTACK) {
        damage += ATTACK_POWER * mult;
        attack++;
      } else if (part.type === RANGED_ATTACK) {
        damage += RANGED_ATTACK_POWER * mult;
        ranged++;
      } else if (part.type === HEAL) {
        heal += HEAL_POWER * mult;
        healParts++;
      }
    }
    return { damage, heal, attack, ranged, healParts };
  },

  // A room's current threat (lethal DAMAGE-PER-TICK, comparable to guardCombatPower): the summed
  // lethal power of the hostiles present, a flat danger for a hostile invader core (it spawns
  // attackers even before any are visible), AND each hostile tower at its MAX output. Towers belong
  // HERE, not as a `towers > 0` exclusion bolted onto every combat consumer — a tower is danger, so
  // the threat module owns it: a towered room then reads unwinnable (winnable() rejects it) and no
  // guard/hunter is ever sized for, dispatched to, or routed into one it can't out-trade (#178).
  // 0 == safe to work in. Source-Keeper rooms are excluded by the static map (never reach an overlord).
  assess(room, hostiles = room.find(FIND_HOSTILE_CREEPS)) {
    let threat = 0;
    for (const hostile of hostiles) threat += this.combatPower(hostile);
    // A hostile DISMANTLER (WORK → razes our structures) or DECLAIMER (CLAIM → attacks our controller) has
    // no combat parts → combatPower 0, so it's harmless to our CREEPS but lethal to our COLONY. In a room WE
    // OWN (home or a founded child) that's a real threat worth a guard, so flag each like an invader core
    // (+1) — enough to read hot and size a CHEAP melee guard (a defenseless raser/declaimer dies easily, so
    // winnable stays trivially true). Scoped to owned rooms, so a harmless WORK/CLAIM economy creep in a
    // neutral/remote room still scores 0 (the husk/economy invariant #105).
    if (room.controller?.my) {
      threat += hostiles.filter(
        (h) => h.getActiveBodyparts(WORK) > 0 || h.getActiveBodyparts(CLAIM) > 0
      ).length;
    }
    const cores = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    });
    if (cores.length) threat += 1;
    const towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });
    threat += towers.length * TOWER_POWER_ATTACK; // max tower damage/tick — conservative, never under-rate
    return threat;
  },

  // The hostiles' combat PART profile — counts of the parts that decide a fight, so
  // the Guard layer (#118) can pick a rock-paper-scissors counter (kite ranged, rush
  // melee) without live vision, reading it back from intel. Recorded alongside the
  // scalar threat because the deciding creep (the overlord at home) usually has no
  // vision of the contested room when it sizes a guard.
  profile(room, hostiles = room.find(FIND_HOSTILE_CREEPS)) {
    const p = { attack: 0, ranged: 0, heal: 0, tough: 0, work: 0, claim: 0 };
    for (const hostile of hostiles) {
      p.attack += hostile.getActiveBodyparts(ATTACK);
      p.ranged += hostile.getActiveBodyparts(RANGED_ATTACK);
      p.heal += hostile.getActiveBodyparts(HEAL);
      p.tough += hostile.getActiveBodyparts(TOUGH);
      // dismantlers (WORK) / declaimers (CLAIM) — guard-killable colony threats in our owned rooms (#233)
      p.work += hostile.getActiveBodyparts(WORK);
      p.claim += hostile.getActiveBodyparts(CLAIM);
    }
    return p;
  },

  // The enemy GROUP model (#268): effective group damage/tick and heal/tick (boost-aware), the count of
  // DEDICATED healers (a creep with more HEAL than offence parts — the focus-fire signal), and the group
  // size. This is what counter-sizing reads to out-pace their HEALING (a healer makes a group invincible
  // below a DPS threshold — summed parts can't express that), and the base a future smart group-lead reads
  // for focus-fire / mass-attack (rangedMassAttack when size ≥ 2 clustered) decisions.
  group(hostiles) {
    let damage = 0;
    let heal = 0;
    let healers = 0;
    for (const hostile of hostiles) {
      const c = this.creepCombat(hostile);
      damage += c.damage;
      heal += c.heal;
      if (c.healParts > c.attack + c.ranged) healers++; // a mostly-HEAL creep — a dedicated healer
    }
    return { damage, heal, healers, size: hostiles.length };
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
      // effectively the guard/hunter force defending the room.
      defense: room.find(FIND_MY_CREEPS).reduce((sum, c) => sum + this.combatPower(c), 0),
      profile: this.profile(room, hostiles),
      enemy: this.group(hostiles), // #268: boost-aware group damage/heal + dedicated-healer count + size
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
  // holds the room, its HOSTILE tower count, and (Season only) any ground Score objects.
  // One writer, refreshed for free on every visit. Consumers:
  //   • scout priority — staleness + room value (#142)
  //   • retaliation target/route safety — tower-free check (#140)
  //   • score collection — ground Score object locations (#24)
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
    // Invader-core intel (#259): an L0 core squatting a remote reserves the controller (kicking our
    // reserver) and must be busted. Record its HP + timing so the operational overlord can size a buster
    // and gate dispatch (invulnerable now? collapses before we arrive?) WITHOUT live vision. Timers are
    // stored ABSOLUTE (Game.time + ticksRemaining) so they stay valid as the intel ages between visits.
    const core = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    })[0];
    // level 0 = reservation core (the cheap pure-ATTACK target); 1-5 = stronghold (towers + boosted
    // defenders — a different, boosted composition, out of this mission's scope, so the overlord skips it).
    out.invaderCore = core
      ? {
          level: core.level,
          hits: core.hits,
          collapseAt: this.effectEndsAt(core, EFFECT_COLLAPSE_TIMER),
          invulnerableUntil: this.effectEndsAt(core, EFFECT_INVULNERABILITY),
        }
      : null;
    // Ground Score objects (Season 10): a creep banks the points by occupying the tile
    // (no structure/carry — see docs/season-10-score-mechanic.md). FIND_SCORES is
    // season-only and the same universal bundle runs on shard2 where it's undefined, so
    // guard the find. Feeds the ScoutOverlord's score-diversion (#24).
    if (typeof FIND_SCORES !== "undefined") {
      out.score = room.find(FIND_SCORES).map((s) => ({
        x: s.pos.x,
        y: s.pos.y,
        score: s.score,
        ticksToDecay: s.ticksToDecay,
      }));
    }
    return out;
  },

  // The absolute game-tick a structure effect (EFFECT_*) expires, or null if absent. Stored absolute
  // (Game.time + ticksRemaining) so an invader-core timer recorded in intel stays valid as it ages.
  effectEndsAt(structure, effectType) {
    const e = (structure.effects || []).find((x) => x.effect === effectType);
    return e ? Game.time + e.ticksRemaining : null;
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

  // The room's profile IF it holds a MOBILE threat a guard can KILL (fresh intel with attack/ranged parts,
  // OR a dismantler/declaimer — a WORK- or CLAIM-bearing hostile that razes our structures or attacks our
  // controller, #233), else null. A guard targets creeps, so a room whose only threat is a tower or invader
  // core (no killable creep) yields null — it can't be cleared by dispatching a guard. The single gate the
  // dispatch/blocker consumers share before sizing a counter-body, so "structural threats aren't guard-
  // killable" lives in ONE place (paired with assess() folding tower danger + the owned-room raser/declaimer +1).
  killableProfile(roomName) {
    const p = this.profileFor(roomName);
    return p && p.attack + p.ranged + (p.work || 0) + (p.claim || 0) > 0 ? p : null;
  },

  // The fresh invader-core intel for a room ({hits, collapseAt, invulnerableUntil}, timers absolute),
  // or null if no core / stale (#259). The data path the bust-core mission sizes its buster and gates
  // dispatch on (invulnerable now? self-collapses before we arrive?) without live vision.
  invaderCore(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return null;
    return intel.invaderCore || null;
  },

  // Is one of OUR remotes seized by an invader core (#259) — a core present, OR the controller reserved
  // by "Invader" (the reservation kicks our reserver and kills mining; treat it as seized). Fresh intel
  // only. The bust-core recogniser; the reservation proxy fires even before recon has captured the core's
  // HP/timers, so a buster dispatches and confirms the core live on arrival.
  coreSeized(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return false;
    return !!intel.invaderCore || intel.reserver === "Invader";
  },

  // The fresh scalar threat of a room (or 0 if stale/unseen) — so the Guard layer can
  // compare a candidate guard's power against what it must beat.
  threatOf(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS) return 0;
    return intel.threat;
  },

  // The fresh enemy GROUP model for a room (#268), or a zeroed default if stale/unseen. Read paths for
  // counter-sizing and (future) smart group tactics: how much the enemy heals, how hard it hits, whether it
  // fields a dedicated healer to focus-fire, and how many bodies it is.
  enemyGroup(roomName) {
    const intel = Memory.roomIntel?.[roomName];
    if (!intel || Game.time - intel.tick > INTEL_FRESH_TICKS || !intel.enemy) {
      return { damage: 0, heal: 0, healers: 0, size: 0 };
    }
    return intel.enemy;
  },

  // The enemy's effective group HEAL/tick (boost-aware) — the term counter-sizing must out-pace, since a
  // healer makes a group un-killable below a DPS threshold (#268). 0 if stale/unseen.
  enemyHeal(roomName) {
    return this.enemyGroup(roomName).heal;
  },

  // The enemy's effective group DAMAGE/tick (boost-aware) — the creep-only offence (towers/cores live in
  // threatOf). Exposed for the data base; counter-sizing still gates on threatOf for the tower/core terms.
  enemyDamage(roomName) {
    return this.enemyGroup(roomName).damage;
  },

  // Count of DEDICATED healers in the room (#268) — the focus-fire signal a future group-lead reads (kill
  // the healer first; killing the brawler while the healer lives just costs a respawn).
  enemyHealers(roomName) {
    return this.enemyGroup(roomName).healers;
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
  // alone. Shared by GuardOverlord (remote clears) and ScoutOverlord (blocker clears).
  WIN_MARGIN: 1.5,

  // Can a guard with `body` clear `roomName` with a comfortable margin? The go/no-go gate
  // both combat consumers use before committing a creep.
  winnable(body, roomName) {
    return this.guardCombatPower(body) >= this.threatOf(roomName) * this.WIN_MARGIN;
  },

  // Winnability of a LIVE creep against `roomName` — `winnable` over its current body. The one place
  // the body→part-type idiom lives, so deniability / danger-aware routing don't each re-spell it.
  winnableBy(creep, roomName) {
    return this.winnable(
      creep.body.map((p) => p.type),
      roomName
    );
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
