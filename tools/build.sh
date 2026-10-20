#!/usr/bin/env bash
# Build the plugin (Release) and copy it into <game>/BepInEx/plugins/.
# Usage: tools/build.sh [extra dotnet build args]
set -euo pipefail
source "$(dirname "$0")/common.sh"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$REPO/Communitan/Communitan.csproj"

[[ -f "$GAME_DIR/BepInEx/core/BepInEx.dll" ]] || { echo "BepInEx missing; run tools/install-bepinex.sh first" >&2; exit 1; }
dotnet build "$PROJ" -c Release -nologo -clp:NoSummary -v:minimal "-p:GameDir=$GAME_DIR" "$@"
OUT="$REPO/Communitan/bin/Release/Communitan.dll"
mkdir -p "$GAME_DIR/BepInEx/plugins"
cp -f "$OUT" "$GAME_DIR/BepInEx/plugins/"
[[ -f "${OUT%.dll}.pdb" ]] && cp -f "${OUT%.dll}.pdb" "$GAME_DIR/BepInEx/plugins/"
echo "Deployed $(basename "$OUT") -> $GAME_DIR/BepInEx/plugins/"
# The mod was called CatanCustomServers before: two copies would patch the game twice. Move the old one aside.
for old in "$GAME_DIR/BepInEx/plugins/CatanCustomServers.dll" "$GAME_DIR/BepInEx/plugins/CatanCustomServers.pdb"; do
  if [[ -f "$old" ]]; then
    mv -f "$old" "$old.disabled"
    echo "Disabled the old plugin: $(basename "$old") -> $(basename "$old").disabled (delete it once you don't need it)"
  fi
done
