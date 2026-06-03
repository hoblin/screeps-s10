#!/usr/bin/env bash
# Read the live colony status snapshot (Memory.status) instantly — no waiting.
# Memory comes gzip'd from the API; decode, extract .status, pretty via toon.
set -euo pipefail
: "${SCREEPS_TOKEN:?set SCREEPS_TOKEN (op item get 'Screeps API token' ...)}"
SHARD="${1:-shard2}"

# Server base. shardSeason auto-selects the Season world; everything else is the
# MMO main world. Override with arg 2 or $SCREEPS_SERVER (arg wins over env).
#   bin/status.sh shardSeason                       # → https://screeps.com/season
#   bin/status.sh shard2                            # → https://screeps.com
#   bin/status.sh <shard> https://my.private:21025  # explicit
case "$SHARD" in
  shardSeason) default_server="https://screeps.com/season" ;;
  *)           default_server="https://screeps.com" ;;
esac
SERVER="${2:-${SCREEPS_SERVER:-$default_server}}"

raw=$(curl -s "$SERVER/api/user/memory?shard=$SHARD" -H "X-Token: $SCREEPS_TOKEN")
data=$(echo "$raw" | python3 -c "import sys,json;print(json.load(sys.stdin).get('data') or '')")
[ -z "$data" ] && { echo "no memory data for shard=$SHARD at $SERVER — check shard/server/token:" >&2; echo "$raw" >&2; exit 1; }

# data is "gz:<base64>" — strip prefix, base64-decode, gunzip.
echo "${data#gz:}" | base64 -d | gunzip 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('status',{}),indent=2))" \
  | toon
