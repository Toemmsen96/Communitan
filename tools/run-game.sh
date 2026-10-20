#!/usr/bin/env bash
# Launch Catan Universe via Proton directly (no Steam UI), muted, optionally headless.
# Usage: tools/run-game.sh [--headless] [--timeout N] [--wait] [--server NAME] [--env PROD|QA|DEV|LOCAL] [--cfg S.K=V]...
#   --headless   no visible window (HEADLESS_METHOD=batchmode|gamescope|xvfb, default batchmode)
#   --timeout N  stop the game after N seconds (detached watchdog)
#   --wait       block until the game exits
#   --server NAME  sets Startup.AutoSelect (entry name from BepInEx/config/Communitan.servers.json, or Official).
#                  Headless runs always set AutoSelect (default: saved "selected") so the picker never blocks.
#   --env ENV      sets Server.OfficialEnv (used by the Official entry)
#   --cfg Section.Key=Value   write any plugin cfg entry (repeatable), e.g. --cfg Debug.AutoConnect=true
#   --instance N   harness instance (see use_instance in common.sh): separate prefix/cfg/logs/device id
#                  (CATAN_DEVICE_ID default harness-device-N); --cfg then only writes the instance cfg.
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
source "$TOOLS/common.sh"

HEADLESS=0; TIMEOUT=0; WAIT=0; SERVER=""; ENV_=""; CFGS=(); INST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless) HEADLESS=1 ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --wait) WAIT=1 ;;
    --server) SERVER="$2"; shift ;;
    --env) ENV_="$2"; shift ;;
    --cfg) CFGS+=("$2"); shift ;;
    --instance) INST="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -n "$INST" ]]; then
  ORIG_COMPAT="$COMPAT_DATA"; ORIG_LIST="$SERVER_LIST"
  use_instance "$INST"
  mkdir -p "$RUN_DIR"
  if [[ ! -d "$COMPAT_DATA/pfx" ]]; then
    echo "Creating prefix copy $COMPAT_DATA (from $ORIG_COMPAT)"
    cp -a --reflink=auto "$ORIG_COMPAT" "$COMPAT_DATA"
  fi
  [[ -f "$SERVER_LIST" || ! -f "$ORIG_LIST" ]] || cp "$ORIG_LIST" "$SERVER_LIST"
  export CATAN_CFG="$PLUGIN_CFG" CATAN_SERVERS="$SERVER_LIST" CATAN_TRAFFIC="$TRAFFIC_LOG" CATAN_LOG="$BEPINEX_LOG"
  export CATAN_DEVICE_ID="${CATAN_DEVICE_ID:-harness-device-$INST}"
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Game already running (pid $(cat "$PID_FILE")); tools/stop-game.sh first" >&2; exit 1
fi
[[ -n "$INST" ]] && rm -f "$BEPINEX_LOG"   # fresh per launch (waiters grep it for milestones)
[[ -x "$PROTON_DIR/proton" ]] || { echo "Proton not found: $PROTON_DIR (set PROTON_DIR)" >&2; exit 1; }
[[ -f "$GAME_DIR/winhttp.dll" ]] || echo "WARN: BepInEx not installed (tools/install-bepinex.sh)" >&2
pgrep -x steam >/dev/null || echo "WARN: Steam client not running; SteamAPI_Init will fail (game may quit or skip Steam login)" >&2

set_cfg() { # section key value
  mkdir -p "$(dirname "$PLUGIN_CFG")"; touch "$PLUGIN_CFG"
  python3 -I - "$PLUGIN_CFG" "$1" "$2" "$3" <<'PY'
import sys, re
path, sec, key, val = sys.argv[1:]
lines = open(path, encoding='utf-8-sig').read().splitlines()
out, cur, done = [], None, False
for i, l in enumerate(lines):
    m = re.match(r'\s*\[(.+)\]\s*$', l)
    if m:
        if cur == sec and not done: out.append(f'{key} = {val}'); done = True
        cur = m.group(1)
    elif cur == sec and re.match(rf'\s*{re.escape(key)}\s*=', l):
        l = f'{key} = {val}'; done = True
    out.append(l)
if not done:
    if cur != sec: out += ['', f'[{sec}]']
    out.append(f'{key} = {val}')
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
}
if [[ $HEADLESS == 1 && -z "$SERVER" ]]; then
  SERVER=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("selected") or "Local")' "$SERVER_LIST" 2>/dev/null || echo Local)
fi
[[ -n "$SERVER" ]] && set_cfg Startup AutoSelect "$SERVER"
[[ -n "$ENV_" ]] && set_cfg Server OfficialEnv "$ENV_"
for kv in "${CFGS[@]}"; do k="${kv%%=*}"; set_cfg "${k%%.*}" "${k#*.}" "${kv#*=}"; done

mkdir -p "$RUN_DIR"
export STEAM_COMPAT_DATA_PATH="$COMPAT_DATA"
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM_ROOT"
export SteamAppId=$APPID SteamGameId=$APPID
# Harness runs always log traffic (plugin default Debug.TrafficLog=false); CATAN_TRAFFIC_LOG=0 to disable.
export CATAN_TRAFFIC_LOG="${CATAN_TRAFFIC_LOG:-1}"
# winhttp=n,b: load BepInEx doorstop. winepulse/winealsa disabled: no audio device -> muted, no sink needed.
export WINEDLLOVERRIDES="winhttp=n,b;winepulse.drv=d;winealsa.drv=d"
export PROTON_LOG=0 WINEDEBUG="${WINEDEBUG:--all}"

winpath() { echo "Z:${1//\//\\}"; }
ARGS=(-logFile "$(winpath "$UNITY_LOG")")
CMD=("$PROTON_DIR/proton" run "$GAME_DIR/CatanUniverse.exe")

if [[ $HEADLESS == 1 ]]; then
  case "${HEADLESS_METHOD:-batchmode}" in
    batchmode) ARGS+=(-batchmode -nographics) ;;
    gamescope) CMD=(gamescope --backend headless -W 1280 -H 720 -- "${CMD[@]}") ;;
    xvfb)      CMD=(xvfb-run -a -s "-screen 0 1280x720x24" "${CMD[@]}") ;;
    *) echo "bad HEADLESS_METHOD" >&2; exit 2 ;;
  esac
fi

cd "$GAME_DIR"
setsid "${CMD[@]}" "${ARGS[@]}" >"$RUN_DIR/proton.out" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PID_FILE"     # session leader; stop-game.sh kills its process group + wineserver
echo "Started pid $PID ${INST:+instance=$INST device=$CATAN_DEVICE_ID }(headless=$HEADLESS method=${HEADLESS_METHOD:-batchmode}, muted, server=${SERVER:-<picker/saved>})"
echo "  BepInEx log: $BEPINEX_LOG"
echo "  Player.log:  $UNITY_LOG"
echo "  Traffic:     $TRAFFIC_LOG"
echo "  Proton out:  $RUN_DIR/proton.out"

if [[ "$TIMEOUT" -gt 0 ]]; then
  setsid bash -c 'sleep "$1"; kill -0 "$2" 2>/dev/null && "$3/stop-game.sh" ${4:+--instance "$4"}' _ "$TIMEOUT" "$PID" "$TOOLS" "$INST" >/dev/null 2>&1 < /dev/null &
  echo "  Watchdog: stop after ${TIMEOUT}s"
fi
if [[ $WAIT == 1 ]]; then
  while kill -0 "$PID" 2>/dev/null; do sleep 2; done
  echo "Game exited"
fi
