// Tiny leveled logger. Memory.loggingLevel: 1=error .. 5=debug (default 3).
const LEVELS = { error: 1, warn: 2, info: 3, debug: 4 };

function emit(level, msg) {
  const want = (Memory && Memory.loggingLevel) || 3;
  if (LEVELS[level] > want) return;
  const tag = { error: "🔴", warn: "🟡", info: "🔵", debug: "⚪" }[level];
  console.log(`${tag} [${Game.time}] ${msg}`);
}

export const log = {
  error: (m) => emit("error", m),
  warn: (m) => emit("warn", m),
  info: (m) => emit("info", m),
  debug: (m) => emit("debug", m),
};
