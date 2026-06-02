// esbuild bundler: src/main.js -> dist/main.js (single file Screeps expects)
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.js"],
  bundle: true,
  outfile: "dist/main.js",
  platform: "node",
  target: "node12", // Screeps runtime is an isolated V8; node12-level features are safe
  format: "cjs", // Screeps loads main.js as CommonJS (module.exports.loop)
  charset: "ascii", // escape any non-ASCII as \uXXXX; Screeps' code-upload JSON
                    // parser chokes on raw multibyte chars (emoji in comments etc.)
  logLevel: "info",
  // Screeps provides Game, Memory, etc. as globals — never bundle/treeshake them away.
  // Keep the bundle readable-ish; no minify so console errors map to real lines.
  minify: false,
  sourcemap: false,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[build] watching src/ … (Ctrl-C to stop)");
} else {
  await esbuild.build(options);
  console.log("[build] dist/main.js written");
}
