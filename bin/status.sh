#!/usr/bin/env bash
# Read the live colony status snapshot (Memory.status) instantly — no waiting.
# Memory comes gzip'd from the API; decode, extract .status, pretty via toon.
set -euo pipefail
: "${SCREEPS_TOKEN:?set SCREEPS_TOKEN (op item get 'Screeps API token' ...)}"
SHARD="${1:-shard2}"

raw=$(curl -s "https://screeps.com/api/user/memory?shard=$SHARD" -H "X-Token: $SCREEPS_TOKEN")
data=$(echo "$raw" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'])")

# data is "gz:<base64>" — strip prefix, base64-decode, gunzip.
echo "${data#gz:}" | base64 -d | gunzip 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('status',{}),indent=2))" \
  | toon
