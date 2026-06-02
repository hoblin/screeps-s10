// ============================================================================
//  Screeps S10 — entry point
//  The Screeps runtime calls module.exports.loop() once per tick.
//  We keep this file thin: bootstrap the Kernel and tick it. All real logic
//  lives in classes (Overmind-style: Kernel -> Colony -> Overlord -> Role).
// ============================================================================
import { Kernel } from "./Kernel.js";
import "./prototypes/index.js"; // install prototype extensions (mixins) on load

// Single long-lived kernel instance. Screeps keeps the global between ticks
// (until a code reset / global reset), so we lazily build colonies each tick
// but reuse the kernel shell.
const kernel = new Kernel();

export function loop() {
  kernel.tick();
}

// Screeps expects CommonJS `module.exports.loop`. esbuild (format: cjs) maps the
// named export above to exports.loop, so the runtime finds it.
