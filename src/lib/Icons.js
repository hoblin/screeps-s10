// ============================================================================
//  Icons — emoji glyphs for at-a-glance, in-game telemetry (#123).
//
//  The push (visual) counterpart to the #103 pull-telemetry trace: every role
//  already tags its per-tick action via Role.note("category:action"), so we map
//  that one tag to an icon the creep say()s — no per-role say() calls to maintain.
//  The Hatchery labels a spawning spawn with the incoming creep's role icon, so we
//  see who's coming before it pops. Visuals only — no gameplay effect.
// ============================================================================

// Action → icon, keyed by the SUFFIX of a note tag (the part after ":"). Compact
// because many tags share an action (e.g. deliver:spawn / deliver:tower → 📤).
export const ACTION_ICON = {
  harvest: "⛏️", "src-fallback": "⛏️", // mining
  gather: "📥", withdraw: "📥", pickup: "📥", // collecting energy
  fill: "📤", spawn: "📤", tower: "📤", storage: "📤", drop: "📤",
  "ctrl-container": "📤", "ctrl-container-full": "📤", // delivering energy
  "to-room": "🏃", "to-post": "🏃", "to-source": "🏃", "to-home": "🏃",
  approach: "🏃", wait: "🏃", // travelling
  hot: "🏳️", // retreating from a contested room
  idle: "💤", hold: "💤", // nothing to do right now
  build: "🔨",
  repair: "🔧",
  upgrade: "🎮", pump: "🎮", // controller
  melee: "⚔️", ranged: "🏹", // guard / warband combat (Guard + behaviors #39)
  park: "🛡️", // guard garrisoning a cleared room's controller
  deny: "🗡️", // guard denying an attacker's remote — sunk-asset retaliation (#140)
  heal: "💉", regroup: "🏃", // warband healer mending an ally / member regrouping (#39)
  score: "💰", // scout diverting to bank a ground Score (#24)
  recycle: "♻️",
  "no-target": "❔",
};

// Role → icon, for the spawn label.
export const ROLE_ICON = {
  miner: "⛏️", hauler: "🚚", worker: "🔨", upgrader: "🎮", reserver: "🚩",
  harvester: "🌾", guard: "⚔️", combatant: "⚔️",
  remoteMiner: "⛏️", remoteHauler: "🚚", remoteWorker: "🔨",
};

// The icon for a note tag like "deliver:ctrl-container" → 📤 (or null if unmapped).
export function actionIcon(tag) {
  if (!tag) return null;
  const i = tag.indexOf(":");
  const suffix = i === -1 ? tag : tag.slice(i + 1);
  return ACTION_ICON[suffix] || null;
}

// The icon for a creep role (❓ for an unknown role).
export function roleIcon(role) {
  return ROLE_ICON[role] || "❓";
}
