#!/usr/bin/env bash
# Stop a game started by tools/run-game.sh (process group + wineserver of the prefix).
# Usage: tools/stop-game.sh [--instance N]   (with --instance only that harness instance is stopped)
set -uo pipefail
source "$(dirname "$0")/common.sh"
INST=""
[[ "${1:-}" == "--instance" ]] && INST="$2"
[[ -n "$INST" ]] && use_instance "$INST"
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
fi
WINEPREFIX="$PFX" "$PROTON_DIR/files/bin/wineserver" -k 2>/dev/null
if [[ -z "$INST" ]]; then
  pkill -TERM -f 'CatanUniverse\.exe' 2>/dev/null
  for _ in $(seq 10); do pgrep -f 'CatanUniverse\.exe' >/dev/null || break; sleep 1; done
  pkill -KILL -f 'CatanUniverse\.exe' 2>/dev/null
else
  for _ in $(seq 10); do kill -0 "${PID:-0}" 2>/dev/null || break; sleep 1; done
fi
[[ -n "${PID:-}" ]] && kill -KILL -- "-$PID" 2>/dev/null
rm -f "$PID_FILE"
echo "Stopped${INST:+ instance $INST}"
