// ============================================================================
//  deploy.mjs — push dist/ to a Screeps branch using the official screeps-api.
//  Replaces the opaque kskitek/screeps-pusher docker action (broke on JSON
//  serialization of unicode escapes). Here we control the payload directly:
//  the official client JSON-encodes the modules correctly.
//
//  Usage:  node deploy.mjs --branch <name> [--dir dist] [--server <url>]
//  Auth:   env SCREEPS_TOKEN (full-access auth token)
// ============================================================================
import { ScreepsAPI } from "screeps-api";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const branch = arg("branch");
const dir = arg("dir", "dist");
const server = arg("server", "https://screeps.com");
const token = process.env.SCREEPS_TOKEN;

if (!branch) {
  console.error("ERROR: --branch is required");
  process.exit(1);
}
if (!token) {
  console.error("ERROR: SCREEPS_TOKEN env var is not set");
  process.exit(1);
}

// Read every .js file in dir into a { moduleName: source } map.
// Screeps module names are filenames without the .js extension.
const modules = {};
for (const file of readdirSync(dir)) {
  if (extname(file) !== ".js") continue;
  const name = basename(file, ".js");
  modules[name] = readFileSync(join(dir, file), "utf8");
}

const names = Object.keys(modules);
if (names.length === 0) {
  console.error(`ERROR: no .js files found in ${dir}/`);
  process.exit(1);
}

console.log(`Deploying ${names.length} module(s) [${names.join(", ")}] -> branch "${branch}" @ ${server}`);

const api = new ScreepsAPI({ token, protocol: "https", hostname: "screeps.com", port: 443 });
if (server !== "https://screeps.com") {
  const u = new URL(server);
  api.opts.hostname = u.hostname;
  api.opts.protocol = u.protocol.replace(":", "");
  api.opts.port = u.port || (u.protocol === "https:" ? 443 : 80);
}

try {
  const res = await api.code.set(branch, modules);
  // Screeps returns HTTP 200 even for logical failures, carrying an { error }
  // body (e.g. "branch does not exist"). A real success is { ok: 1 }. Require
  // ok===1 so anything unexpected fails the deploy instead of being swallowed.
  if (!res || res.error || res.ok !== 1) {
    console.error("Deploy rejected by server:", JSON.stringify(res));
    process.exit(1);
  }
  console.log("Deploy OK:", JSON.stringify(res));
} catch (err) {
  console.error("Deploy failed:", err.message || err);
  process.exit(1);
}
