# Shared paths for tools/*.sh. Source, don't execute. Override via env.
STEAM_ROOT="${STEAM_ROOT:-$HOME/.local/share/Steam}"
APPID=544730
GAME_DIR="${GAME_DIR:-$STEAM_ROOT/steamapps/common/Catan Universe}"
COMPAT_DATA="${COMPAT_DATA:-$STEAM_ROOT/steamapps/compatdata/$APPID}"
PFX="$COMPAT_DATA/pfx"
PLAYER_LOG_DEFAULT="$PFX/drive_c/users/steamuser/AppData/LocalLow/United Soft Media Verlag GmbH/Catan Universe/Player.log"
BEPINEX_LOG="$GAME_DIR/BepInEx/LogOutput.log"
TRAFFIC_LOG="$GAME_DIR/BepInEx/traffic.jsonl"
PLUGIN_CFG="$GAME_DIR/BepInEx/config/Toemmsen96.Communitan.cfg"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/communitan"
RUN_DIR="$CACHE_DIR/run"
# Proton build: default = what created the prefix (Proton Experimental, prefix version 11.x).
PROTON_DIR="${PROTON_DIR:-$STEAM_ROOT/steamapps/common/Proton - Experimental}"
PID_FILE="$RUN_DIR/game.pid"
UNITY_LOG="$RUN_DIR/Player.log"
SERVER_LIST="$GAME_DIR/BepInEx/config/Communitan.servers.json"

# Harness instance N (run-game.sh/stop-game.sh --instance N, tools/mp-smoke.sh): own Proton prefix (copy of the
# game's), own run dir, plugin cfg, server list, traffic + BepInEx log (passed to the mod via CATAN_* env), own device id.
# The user's prefix, cfg and servers.json are never touched.
use_instance() {
  INSTANCE="$1"
  COMPAT_DATA="$CACHE_DIR/prefix-$INSTANCE"
  PFX="$COMPAT_DATA/pfx"
  RUN_DIR="$CACHE_DIR/run-$INSTANCE"
  PID_FILE="$RUN_DIR/game.pid"
  UNITY_LOG="$RUN_DIR/Player.log"
  PLUGIN_CFG="$RUN_DIR/plugin.cfg"
  SERVER_LIST="$RUN_DIR/servers.json"
  TRAFFIC_LOG="$RUN_DIR/traffic.jsonl"
  BEPINEX_LOG="$RUN_DIR/bepinex.log"
}
