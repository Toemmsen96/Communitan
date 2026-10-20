#!/usr/bin/env bash
# Install BepInEx 5 (win x86) into the Catan Universe game dir. Idempotent.
# Usage: tools/install-bepinex.sh [version]   (default: latest 5.4.23.x from GitHub, fallback pinned)
set -euo pipefail
source "$(dirname "$0")/common.sh"

PINNED=5.4.23.5
VER="${1:-}"
if [[ -z "$VER" ]]; then
  VER=$(curl -fsSL 'https://api.github.com/repos/BepInEx/BepInEx/releases?per_page=20' 2>/dev/null \
        | grep -o '"tag_name": *"v5\.4\.23\.[0-9]*"' | head -n1 | grep -o '5\.4\.23\.[0-9]*' || true)
  VER="${VER:-$PINNED}"
fi

[[ -f "$GAME_DIR/CatanUniverse.exe" ]] || { echo "Game not found: $GAME_DIR" >&2; exit 1; }

if [[ -f "$GAME_DIR/.doorstop_version" && -f "$GAME_DIR/BepInEx/core/BepInEx.dll" && -f "$GAME_DIR/.bepinex_version" ]] \
   && [[ "$(cat "$GAME_DIR/.bepinex_version")" == "$VER" ]]; then
  echo "BepInEx $VER already installed in $GAME_DIR"
  exit 0
fi

ZIP="BepInEx_win_x86_$VER.zip"
DL="$CACHE_DIR/bepinex-$VER"          # fresh dir per version, holds only the download
mkdir -p "$DL"
if [[ ! -f "$DL/$ZIP" ]]; then
  echo "Downloading $ZIP"
  curl -fsSL --retry 3 -o "$DL/$ZIP.part" "https://github.com/BepInEx/BepInEx/releases/download/v$VER/$ZIP"
  mv "$DL/$ZIP.part" "$DL/$ZIP"
fi
unzip -tq "$DL/$ZIP" >/dev/null

# Extract directly into game dir; overwrite core files, never touch BepInEx/config or plugins.
unzip -oq "$DL/$ZIP" -d "$GAME_DIR"
mkdir -p "$GAME_DIR/BepInEx/plugins" "$GAME_DIR/BepInEx/config"
echo "$VER" > "$GAME_DIR/.bepinex_version"
echo "Installed BepInEx $VER into $GAME_DIR"
echo "Proton needs WINEDLLOVERRIDES=\"winhttp=n,b\" (tools/run-game.sh sets it; for Steam launches add"
echo "  WINEDLLOVERRIDES=\"winhttp=n,b\" %command%   to the game's launch options)."
