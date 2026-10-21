#!/usr/bin/env bash
# AI opponents for testing: headless game instances that log in as guests, search a match and let the game's AI
# play their seat (harness Debug.AutoPlay). See tools/README.md "Bots".
#
#   tools/bots.sh start [--mode free|auto] [--players N] [--count N] [--server URL] [--key KEY] [--timeout SEC] [--first N] [--no-wait]
#   tools/bots.sh stop
#   tools/bots.sh status
#
# Defaults: --mode free (Free Play: works for free-tier accounts), --players 3, --count players-1,
# --server http://127.0.0.1:7350, --key defaultkey, --timeout 2400, instances from --first 2.
# Start your own game from Steam FIRST: while bots run, Steam shows the game as running and may refuse to launch it.
set -uo pipefail
cd "$(dirname "$0")/.."
source tools/common.sh

CMD="${1:-}"; shift || true
MODE=free; PLAYERS=3; COUNT=""; SERVER="http://127.0.0.1:7350"; KEY=defaultkey; TIMEOUT=2400; FIRST=2; WAIT=1
STATUS_KEY="${NAKAMA_HTTP_KEY:-catan-public-status}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift ;;
    --players) PLAYERS="$2"; shift ;;
    --count) COUNT="$2"; shift ;;
    --server) SERVER="$2"; shift ;;
    --key) KEY="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --first) FIRST="$2"; shift ;;
    --no-wait) WAIT=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$SERVER" == *://* ]] || SERVER="http://$SERVER"
[[ "${SERVER#*://}" == *:* ]] || SERVER="$SERVER:7350"

running_instances() {
  for f in "$CACHE_DIR"/run-*/game.pid; do
    [[ -f "$f" ]] || continue
    local n="${f%/game.pid}"; n="${n##*-}"
    [[ "$n" =~ ^[0-9]+$ ]] && kill -0 "$(cat "$f")" 2>/dev/null && echo "$n"
  done
}

server_status() {
  curl -sf "$SERVER/v2/rpc/COMMUNITAN_STATUS?http_key=$STATUS_KEY&unwrap" || echo "(no status: server down or older server)"
}

case "$CMD" in
  start)
    case "$MODE" in
      auto) AUTOPLAY=AutoMatch ;;
      free) AUTOPLAY=QuickMatch ;;
      *) echo "--mode must be free or auto" >&2; exit 2 ;;
    esac
    [[ -n "$COUNT" ]] || COUNT=$((PLAYERS - 1))
    HOST="${SERVER#*://}"; SCHEME="${SERVER%%://*}"
    for ((i = 0; i < COUNT; i++)); do
      n=$((FIRST + i))
      use_instance "$n"
      if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "instance $n already running (tools/bots.sh stop first)"; continue
      fi
      mkdir -p "$RUN_DIR"
      # Instance server list with one entry "Bots" pointing at the target server (user's list is never touched).
      python3 - "$SERVER_LIST" "$SCHEME" "${HOST%:*}" "${HOST##*:}" "$KEY" <<'PY'
import json, sys
path, scheme, host, port, key = sys.argv[1:]
try: d = json.load(open(path))
except Exception: d = {"servers": []}
d["servers"] = [s for s in d.get("servers", []) if s.get("Name") != "Bots"] + [
    {"Name": "Bots", "Host": host, "Port": int(port), "Scheme": scheme, "ServerKey": key, "LegacyDeviceId": True}]
d["selected"] = "Bots"
json.dump(d, open(path, "w"), indent=2)
PY
      tools/run-game.sh --instance "$n" --headless --server Bots --timeout "$TIMEOUT" \
        --cfg Debug.AutoPlay="$AUTOPLAY" --cfg Debug.AutoPlayPlayers="$PLAYERS" > "$RUN_DIR/bots.out" 2>&1 &
      echo "started bot instance $n ($MODE match, $PLAYERS players, $SERVER, stops after ${TIMEOUT}s)"
    done
    if [[ "$WAIT" == 1 ]]; then
      echo "waiting until the bots are searching (up to 3 min; Ctrl+C is fine, they keep starting)..."
      for _ in $(seq 90); do
        s=$(server_status)
        python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("searching",0)+d.get("playing",0) >= int(sys.argv[2]) else 1)' "$s" "$COUNT" 2>/dev/null && break
        sleep 2
      done
      echo "server: $(server_status)"
    fi
    echo "Now search the same mode in your game. Stop with: tools/bots.sh stop"
    ;;
  stop)
    found=0
    for n in $(running_instances); do tools/stop-game.sh --instance "$n" >/dev/null 2>&1; echo "stopped bot instance $n"; found=1; done
    [[ "$found" == 1 ]] || echo "no bot instances running"
    ;;
  status)
    inst=$(running_instances | tr '\n' ' ')
    echo "bot instances running: ${inst:-none}"
    for n in $inst; do
      use_instance "$n"
      echo "  $n: $(grep -hoE 'Milestone: [^(]*' "$BEPINEX_LOG" "$GAME_DIR/BepInEx/LogOutput.log" 2>/dev/null | tail -1)"
    done
    echo "server: $(server_status)"
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
