#!/usr/bin/env bash
# Referee self-test: replays referee/test/fixtures/*.json (recorded real base-game matches, sanitized) -> ok + recorded
# ranks; tampered copies (costs, positions, dice, dev card, trades, robber) -> "invalid" for the tampering seat.
# Needs tools/referee-setup.sh first (game files + build). Exit code = failures.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DLL="$ROOT/referee/bin/publish/Referee.dll"
[ -f "$DLL" ] || { echo "build missing: run tools/referee-setup.sh" >&2; exit 2; }
export GLIBC_TUNABLES=glibc.rtld.execstack=2
out="$(dotnet "$DLL" selftest "$ROOT/referee/test/fixtures" "$@" 2>&1)" || rc=$?
echo "$out" | grep -v '^referee: ' | cut -c1-220
echo "$(echo "$out" | grep -c '^ok ') ok, $(echo "$out" | grep -c '^FAIL') failed"
exit ${rc:-0}
