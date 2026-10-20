#!/usr/bin/env bash
# Build release zips into dist/. Usage: tools/release.sh [version]   (default 0.1.0)
# Needs the game installed (builds the plugin), dotnet, node/npm, zip, curl.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-0.1.0}"
BEPINEX_VER="${BEPINEX_VER:-5.4.23.5}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be x.y.z" >&2; exit 1; }
ROOT="$PWD"; DIST="$ROOT/dist"; STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
rm -rf "$DIST"; mkdir -p "$DIST"

# --- plugin version
sed -i "s/modVersion = \"[^\"]*\"/modVersion = \"$V\"/" Communitan/Plugin.cs
sed -i "s#<Version>[^<]*</Version>#<Version>$V</Version>#" Communitan/Communitan.csproj
dotnet build Communitan/Communitan.csproj -c Release ${GAME_DIR:+-p:GameDir="$GAME_DIR"} -o "$STAGE/out" >/dev/null
DLL="$STAGE/out/Communitan.dll"; [[ -f "$DLL" ]] || { echo "dll build failed" >&2; exit 1; }

# --- mod zips
M="$STAGE/mod"; mkdir -p "$M/BepInEx/plugins"
cp "$DLL" "$M/BepInEx/plugins/"; cp LICENSE "$M/LICENSE"
cat > "$M/INSTALL.txt" <<TXT
Communitan $V - community servers for Catan Universe (unofficial fan project,
not affiliated with USM / CATAN GmbH; no warranty; mods may violate the game's ToS).

INSTALL (Windows): 1) Install BepInEx 5 x86 (win_x86, 5.4.23.x) into the game folder
  (next to CatanUniverse.exe): https://github.com/BepInEx/BepInEx/releases
  The "-with-BepInEx" zip already contains it. 2) Copy this zip's BepInEx folder into the game
  folder (merge). 3) Start the game once, pick a server in the list (or press F10 later).
INSTALL (Linux / Steam Proton): same files; Steam > Catan Universe > Properties > Launch options:
  WINEDLLOVERRIDES="winhttp=n,b" %command%

PRIVACY - read before joining a community server:
 - Servers are run by strangers. NEVER use your official Catan login or a reused password:
   the game sends email + password (plain text) to the selected server. Create a separate account or play as guest.
 - http:// servers are unencrypted. Servers see your IP, email, device id, name, chats, matches.
 - Progress never carries over between official and custom servers (or between custom servers).
 - Steam ID is not sent to custom servers; analytics are blocked while one is selected.
 Full details: README.md in the project repository. Use at your own risk.
TXT
(cd "$M" && zip -qr "$DIST/Communitan-$V.zip" BepInEx INSTALL.txt LICENSE)
BZ="$HOME/.cache/communitan/bepinex-$BEPINEX_VER/BepInEx_win_x86_$BEPINEX_VER.zip"
if [[ ! -f "$BZ" ]]; then
  mkdir -p "$(dirname "$BZ")"
  curl -fsSL --retry 3 -o "$BZ.part" "https://github.com/BepInEx/BepInEx/releases/download/v$BEPINEX_VER/BepInEx_win_x86_$BEPINEX_VER.zip" && mv "$BZ.part" "$BZ"
fi
B="$STAGE/bundle"; mkdir -p "$B"; (cd "$B" && unzip -q "$BZ")
cp -r "$M/BepInEx/plugins/." "$B/BepInEx/plugins/"; cp "$M/INSTALL.txt" "$B/INSTALL.txt"; cp "$M/LICENSE" "$B/LICENSE-Communitan.txt"
BL="$(dirname "$BZ")/LICENSE-BepInEx.txt"
[[ -f "$BL" ]] || curl -fsSL --retry 3 -o "$BL" "https://raw.githubusercontent.com/BepInEx/BepInEx/v$BEPINEX_VER/LICENSE"
cp "$BL" "$B/LICENSE-BepInEx.txt"   # BepInEx is MIT; the archive ships no license file
(cd "$B" && zip -qr "$DIST/Communitan-$V-with-BepInEx.zip" .)

# --- server zip
(cd server && { [[ -d node_modules ]] || npm ci; } && npm run build)
S="$STAGE/communitan-server-$V"; mkdir -p "$S/tools" "$S/build"
cp server/compose.yml server/local.yml server/.env.example server/Caddyfile "$S/"
cp server/build/index.js "$S/build/"; cp -r server/data "$S/data"; rm -f "$S/data/almanac.json"   # USM text: hosts generate it
cp tools/server-init.sh tools/gen-almanac.py "$S/tools/"; cp docs/HOSTING.md "$S/HOSTING.md"; cp LICENSE "$S/"
(cd "$STAGE" && zip -qr "$DIST/communitan-server-$V.zip" "communitan-server-$V")
(cd "$DIST" && sha256sum *.zip > SHA256SUMS)
ls -l "$DIST"
