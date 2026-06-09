// esbuild bundler: src/main.js -> dist/main.js (single file Screeps expects)
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

// Per-server expansion map: the same bundle ships to two servers, but each must
// carry ONLY its own remote-mining map (Season homes vs Main shard2 homes — a
// server has no business holding the other's data). The bot imports a logical
// "./data/expansionMap.json"; this plugin resolves it to the shard-specific
// source file at bundle time, so `build` (Season, the default) and
// `build --main` (shard2) emit different bundles. The deploy pipeline builds
// once per server with the matching flag.
const MAP_SHARD = process.argv.includes("--main") ? "shard2" : "shardSeason";
const mapFile = fileURLToPath(new URL(`./src/data/expansionMap.${MAP_SHARD}.json`, import.meta.url));
const expansionMapPlugin = {
  name: "shard-expansion-map",
  setup(build) {
    build.onResolve({ filter: /data\/expansionMap\.json$/ }, () => ({ path: mapFile }));
  },
};

const options = {
  entryPoints: ["src/main.js"],
  bundle: true,
  outfile: "dist/main.js",
  platform: "node",
  target: "node12", // Screeps runtime is an isolated V8; node12-level features are safe
  format: "cjs", // Screeps loads main.js as CommonJS (module.exports.loop)
  charset: "utf8", // esbuild defaults to ascii (emits \u{...}); keep unicode raw
  logLevel: "info",
  plugins: [expansionMapPlugin],
  // Screeps provides Game, Memory, etc. as globals — never bundle/treeshake them away.
  // Keep the bundle readable-ish; no minify so console errors map to real lines.
  minify: false,
  sourcemap: false,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`[build] watching src/ … map=${MAP_SHARD} (Ctrl-C to stop)`);
} else {
  await esbuild.build(options);
  console.log(`[build] dist/main.js written (expansion map: ${MAP_SHARD})`);
}
