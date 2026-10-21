#!/usr/bin/env bash
# L3 referee setup (docs/design/level3-referee.md): prepares the game files the referee needs from YOUR OWN game install
# and builds the referee. Output dir (default referee/game/, git-ignored; never commit or redistribute it):
#   Managed/    game assemblies; UnityEngine*.dll rewritten by referee/stubber (InternalCalls -> managed stubs)
#   assets/     rules + base-game scenario TextAssets, shufflemodes.json (referee/setup/extract_assets.py)
# Then builds referee/ against it (Release, publish -> referee/bin/publish).
# Usage: tools/referee-setup.sh [<game dir>] [<out dir>]   (game dir default: $GAME_DIR or the Steam path)
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="${1:-${GAME_DIR:-$HOME/.local/share/Steam/steamapps/common/Catan Universe}}"
OUT="${2:-$ROOT/referee/game}"
DATA="$GAME/CatanUniverse_Data"
[ -f "$DATA/Managed/Assembly-CSharp.dll" ] || { echo "not a Catan Universe install: $GAME" >&2; exit 1; }
command -v dotnet >/dev/null || { echo "needs the .NET 8 SDK (dotnet)" >&2; exit 1; }
mkdir -p "$OUT/Managed"
OUT="$(cd "$OUT" && pwd)"

echo "== stub Unity engine assemblies -> $OUT/Managed"
dotnet build -c Release -nologo -v q "$ROOT/referee/stubber/Stubber.csproj" -o "$ROOT/referee/stubber/bin/out" | { grep -E "error|rror " || true; }
dotnet "$ROOT/referee/stubber/bin/out/Stubber.dll" "$DATA/Managed" "$OUT/Managed" | tail -n 3
echo "== copy game assemblies (Mono framework assemblies skipped: .NET 8 provides them)"
n=0
for f in "$DATA/Managed"/*.dll; do
    b="$(basename "$f")"
    case "$b" in UnityEngine*.dll|mscorlib.dll|netstandard.dll|System.dll|System.*.dll|Mono.*.dll) continue ;; esac
    cp -f "$f" "$OUT/Managed/$b"; n=$((n + 1))
done
echo "$n copied"
echo "== extract TextAssets + scenario shuffle modes"
python3 -I "$ROOT/referee/setup/extract_assets.py" "$DATA" "$OUT"

echo "== build referee"
dotnet publish -c Release -nologo -v q "$ROOT/referee/Referee.csproj" -p:RefereeGame="$OUT" -o "$ROOT/referee/bin/publish" | { grep -E "error" || true; }
[ -f "$ROOT/referee/bin/publish/Referee.dll" ] || { echo "referee build failed" >&2; exit 1; }
echo "done. Run: GLIBC_TUNABLES=glibc.rtld.execstack=2 dotnet $ROOT/referee/bin/publish/Referee.dll serve --game $OUT --port 8790"
