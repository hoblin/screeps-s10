// ============================================================================
//  deploy.mjs — push dist/ to a Screeps branch using the official screeps-api.
//  Replaces the opaque kskitek/screeps-pusher docker action (broke on JSON
//  serialization of unicode escapes). Here we control the payload directly:
//  the official client JSON-encodes the modules correctly.
//
//  Usage:  node deploy.mjs [--branch default] [--dir dist] [--server <url>]
//  Auth:   env SCREEPS_TOKEN (full-access auth token)
//  Single-branch model: defaults to the live "default" branch (= prod).
// ============================================================================
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const branch = arg("branch", "default");
const dir = arg("dir", "dist");
const server = arg("server", "https://screeps.com");
const token = process.env.SCREEPS_TOKEN;

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

// NOTE: we POST directly to `${server}/api/user/code` rather than using the
// screeps-api client's `api.code.set()`. That client caches its host at
// construction and ignores later `api.opts.hostname` overrides, so a
// `--server https://screeps.com/season` deploy silently went to the MAIN
// server and the season branch stayed empty while still returning {ok:1}.
// A plain fetch to the exact server URL is unambiguous.
try {
  const res = await fetch(`${server}/api/user/code`, {
    method: "POST",
    headers: { "X-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ branch, modules }),
  });
  const body = await res.json().catch(() => null);
  // Screeps returns HTTP 200 even for logical failures, carrying an { error }
  // body (e.g. "branch does not exist"). A real success is { ok: 1 }. Require
  // ok===1 so anything unexpected fails the deploy instead of being swallowed.
  if (!res.ok || !body || body.error || body.ok !== 1) {
    console.error(`Deploy rejected by ${server} (HTTP ${res.status}):`, JSON.stringify(body));
    process.exit(1);
  }
  console.log("Deploy OK:", JSON.stringify(body));
} catch (err) {
  console.error("Deploy failed:", err.message || err);
  process.exit(1);
}
