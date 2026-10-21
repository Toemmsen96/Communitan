# tools/

Linux (Proton) dev harness. Paths come from `tools/common.sh` (override `GAME_DIR`, `STEAM_ROOT`, `PROTON_DIR` via env).

| Script | What it does |
|---|---|
| `install-bepinex.sh [ver]` | Downloads BepInEx 5.4.23.x **win_x86** to `~/.cache/communitan/bepinex-<ver>/` and extracts it into the game dir (idempotent, keeps `BepInEx/config` + `plugins`). |
| `server-init.sh [dir]` | Writes random secrets to `server/.env` (idempotent, never overwrites). Also shipped in the server zip. |
| `release.sh [ver]` | Sets plugin version (Plugin.cs + csproj), builds `dist/Communitan-<v>.zip`, `-with-BepInEx.zip` (BepInEx 5.4.23.5 x86 + MIT license), `communitan-server-<v>.zip`, `SHA256SUMS`. Default 0.1.0; needs the game dir to build the dll. |
| `bots.sh start\|stop\|status [options]` | AI opponents for testing: headless guest instances that search a match and let the game's AI play their seat. See **Bots** below. |
| `build.sh` | `dotnet build -c Release` of the plugin (`-p:GameDir=...`), copies dll+pdb to `<game>/BepInEx/plugins/`. Moves a leftover plugin from the old name (`CatanCustomServers.dll`/`.pdb`) aside to `*.disabled`, since two copies would patch the game twice. |
| `gen-almanac.py [CatanUniverse_Data]` | Converts the almanac of **your own** game install (`StreamingAssets/Almanac`) to `server/data/almanac.json` (`data/` in the server zip, which ships this script). Optional, gitignored (USM text); see docs/HOSTING.md. |
| `gen-items.py [capture.jsonl] [--game DIR]` | Writes `server/data/{items,shop,prod}.json` with ids + technical fields only (no USM names/descriptions/prices), from a PROD capture (default `docs/protocol/captures/private/prod-startup.jsonl`, local only); without one it re-strips the committed files. Checks `url3d` against the game's AssetBundles. |
| `capture-schema.py <capture.jsonl>` | Prints a schema-only copy of a traffic capture (keys, ids, flags; free text -> `"<text>"`), safe to commit (docs/protocol/captures/README.md). |
| `reset-password.sh <email> <new-password>` | Operator password reset via the Nakama console API (credentials from `server/.env`). |
| `run-game.sh [--headless] [--timeout N] [--wait] [--server NAME] [--env PROD\|QA\|DEV\|LOCAL] [--cfg Sec.Key=Val]` | Launches the game through Proton directly, always muted; writes pid to `~/.cache/communitan/run/game.pid`; prints log paths. |
| `stop-game.sh [--instance N]` | Kills the launched process group, the game exe and the prefix's wineserver (with `--instance`: only that harness instance). |
| `run-game.sh --instance N ...` | Harness instance N: own Proton prefix `~/.cache/communitan/prefix-N` (reflink copy of the game's, created once), run dir `run-N/` with `plugin.cfg`, `servers.json`, `traffic.jsonl`, `bepinex.log`, `Player.log`, device id `harness-device-N` (env `CATAN_DEVICE_ID`). `--cfg` only writes the instance cfg; the user's cfg/servers.json/prefix are never touched. Several instances run concurrently (Steam allows it). |
| `mp-smoke.sh [--mode QuickMatch\|Lobby] [--reconnect SEC] [--timeout SEC] [--timescale X] [--keep] [--summary-only]` | Two headless instances play a full online match against the **Local** server, the game's AI playing both seats (`Debug.AutoPlay`). `--mode Lobby`: instance 1 hosts a custom lobby and invites instance 2. `--reconnect N`: kill + relaunch instance 2 N s after both are in game (expects automatic rejoin). Prints per-client counts (matched, actions, errors, GAME_WON, GAME_MULTIPLAYER_RESULT, rejoin, exceptions) + server errors; exit 0 = every client got the result. A quick match takes ~8 min. More: `--server URL` (another server, instance list entry "Smoke"), `--first N` (instances N.., default 1), `--players N --expansion CatanCitiesAndKnights` (N-client quick match of an expansion), `--container NAME` (server log). With server dice (`full`) the summary also compares the mod's RNG state per action across clients (desync check). |

Example harness run: `tools/build.sh && tools/run-game.sh --headless --timeout 90 --server Local --cfg Debug.AutoConnect=DeviceLogin`
then `tail -f "$GAME/BepInEx/LogOutput.log"` / `jq -c '[.dir,.id]' "$GAME/BepInEx/traffic.jsonl"`.

## Bots (play against AI opponents on a custom server)
Headless game instances that log in as guests (`Bot<id>`), search a match like a player would, and let the game's own AI play their seat. Useful for testing online play alone.

1. **Start your own game from Steam first.** While bots run, Steam shows Catan Universe as running and may refuse to launch it.
2. `tools/bots.sh start` — 2 bots for base-game **Free Play** (free match, 3 players). Waits until they're searching.
3. In the game, search the **same mode and player count** (Free Play, base game, 3 players).
4. `tools/bots.sh status` — running bots, their last milestone, and the server's online/playing/searching counts.
5. `tools/bots.sh stop` — stop all bots (Steam's Stop button can't, Steam didn't launch them).

Options for `start`:
| Option | Default | Meaning |
|---|---|---|
| `--mode free\|auto` | `free` | `free` = free match (Free Play, `PlayFreeMatch`; works for free-tier accounts); `auto` = auto match (the menu's quickplay button, needs the base game). The two never pair with each other. |
| `--players N` | `3` | Exact player count the bots search (must equal yours; base-game quickplay is 3). |
| `--count N` | players − 1 | Number of bots. |
| `--server URL` | `http://127.0.0.1:7350` | Any custom server (`host`, `host:port` or `http(s)://host:port`). Bots create guest accounts there. |
| `--key KEY` | `defaultkey` | That server's server key. |
| `--timeout SEC` | `2400` | Each bot stops itself after this. |
| `--first N` | `2` | First harness instance number (instances use `~/.cache/communitan/run-N/`). |
| `--no-wait` | | Don't wait for the bots to start searching. |

Free tier: on a server with `CATAN_ENTITLEMENTS=free` (the default) your own account owns no expansion, like a free official account, so the menu's base-game quickplay (auto match) shows the shop instead of "find game". Search **Free Play** (the bots' default), or for quickplay use `--mode auto` with a server in `owned` mode after logging in to the official servers once (mirrors your purchases), or the dev unlock below. The bots start their match directly and play in every mode (checked: 2 free-tier bots, auto match).

Notes: a bot only searches once; after a match ends, run `stop` + `start` again. Bots never accept trades they don't like (the game's AI decides) and don't accept lobby invites or friend requests. Logs: `run-N/bepinex.log`, `run-N/traffic.jsonl`.

## Dev unlock (local testing only)
`CATAN_DEV_UNLOCK_ALL=1` (Nakama runtime env) unlocks every expansion and item and shows 99999 gold for every player, like older versions of this server, and overrides `CATAN_ENTITLEMENTS`. The server log prints a loud warning and the server list shows "everything unlocked (dev)". **Only use it on a server nobody else can reach**: handing out paid content is your responsibility ([README: Operator responsibility and liability](../README.md#operator-responsibility-and-liability)). It is deliberately not in `compose.yml`, `.env` or the release. For your local compose server, create the untracked `server/compose.dev.yml` (git-ignored):
```yaml
services:
  nakama:
    command: ["nakama", "--runtime.env", "CATAN_DEV_UNLOCK_ALL=1"]   # extra Nakama flags after the first item
```
and recreate with `podman-compose -f compose.yml -f compose.dev.yml up -d`; a plain `podman-compose up -d` turns it off again.

## Harness mod settings (`[Debug]` in the plugin cfg; instance runs get them via `--cfg`)
- `AutoPlay = Off|QuickMatch|AutoMatch|HostLobby|JoinLobby`: after login (implies `AutoConnect=DeviceLogin`; a stored login is reused instead) the mod starts a base-game free match (`QuickMatch`) or auto match (`AutoMatch`) with `AutoPlayPlayers` players (0 = mode default), or hosts a lobby and invites the user id found in env `CATAN_INVITE_FILE`/`CATAN_INVITE_ID`, or accepts the first lobby invite (writing its own id to `CATAN_INVITE_FILE`). In game, the local seat is played by the game's AI (`DelayedHybridPlayerController`, the compiled-out AutoPilot "autoPlay" path). A running session found at login is rejoined by the game itself first.
- `DeviceIdOverride` (env `CATAN_DEVICE_ID` wins): replaces `SystemInfo.deviceUniqueIdentifier` -> distinct guest accounts per instance. Fresh guests get display name `Bot<last 6 id chars>` (env `CATAN_PLAYER_NAME`).
- `UnityLog = true`: keep the game's `Debug.Log` (production builds disable it) -> Player.log shows `MatchConnectStateMachine`, `NakamaSender`, ... lines.
- `AutoPlayExpansion` (default `CatanBaseGame`): expansion of the QuickMatch/AutoMatch, e.g. `CatanCitiesAndKnights` (no free-match scenario: its first regular scenario).
- `AutoPlayTimeScale`: `Time.timeScale` in game (default 1; untested above 1).
- Env paths (set by `--instance`): `CATAN_CFG`, `CATAN_SERVERS`, `CATAN_TRAFFIC`, `CATAN_LOG`.
- `Debug.TrafficLog` defaults to false; `run-game.sh` (and so `mp-smoke.sh`) exports `CATAN_TRAFFIC_LOG=1`, which forces it on without touching the cfg (`CATAN_TRAFFIC_LOG=0` to disable).
- Privacy hardening applies whenever a custom server is selected (`Privacy.BlockAnalytics`, STEAM_ID stripping, per-server device id). Harness instances are unaffected by the salting: `DeviceIdOverride`/`CATAN_DEVICE_ID` always wins.

## Logs / files
- BepInEx: `<game>/BepInEx/LogOutput.log` (look for `Milestone:` and `Effective NakamaConfig:` lines)
- Unity: `~/.cache/communitan/run/Player.log` (passed via `-logFile`)
- Traffic: `<game>/BepInEx/traffic.jsonl`, one `{t,dir:send|recv|push|auth,id,rid?,type?,data}` per line (appends; delete to reset)
- Plugin cfg: `<game>/BepInEx/config/Toemmsen96.Communitan.cfg`; server list: `<game>/BepInEx/config/Communitan.servers.json`

## Renamed from CatanCustomServers
- The harness cache moved from `~/.cache/catan-custom-servers/` to `~/.cache/communitan/` (prefixes, run dirs, BepInEx download). The scripts don't move it; delete the old directory once you don't need it (instance prefixes are recreated on the next run).
- On first start the mod copies `Toemmsen96.CatanCustomServers.cfg`, `CatanCustomServers.servers.json` and `CatanCustomServers.entitlements.json` in `BepInEx/config/` to the new names if those are missing (logged; old files are kept and can be deleted).

## Gotchas
- **Proton build**: the prefix was created by *Proton Experimental* (11.x); the scripts default to it. GE-Proton10 would downgrade the prefix.
- **BepInEx under Proton** needs `WINEDLLOVERRIDES="winhttp=n,b"`. `run-game.sh` sets it; for Steam launches add `WINEDLLOVERRIDES="winhttp=n,b" %command%` to launch options.
- **Mute**: `winepulse.drv=d;winealsa.drv=d` in `WINEDLLOVERRIDES` -> Wine has no audio device, Player.log shows `FMOD initialized on nosound output`. No null sink / pactl changes needed.
- **Headless**: Unity `-batchmode -nographics` (default) reaches the main menu and the login flow (verified via `Milestone:` lines and a full device login against the local server). Fallbacks: `HEADLESS_METHOD=gamescope` (`gamescope --backend headless`) or `HEADLESS_METHOD=xvfb` (untested). Null GfxDevice spams shader errors in Player.log; ignore.
- **Steam must be running** (and logged in): `GameRoot.SetupDefaultGameOptions` busy-waits on `SteamManager.Initialized`, so without Steam the game hangs before the main menu. `SteamAppId`/`SteamGameId=544730` are exported so `RestartAppIfNecessary` does not bounce the launch through Steam.
- **No traffic without login**: Nakama only starts on a login action (`NakamaConnector.StartGameSparks`). Headless has no UI, so use `--cfg Debug.AutoConnect=Connect` (connect only, still 0 requests) or `=DeviceLogin` (guest login; **creates a device account on the selected server**, so only use it against our own server).
- **Picker**: headless runs always set `Startup.AutoSelect` (from `--server`, else the saved `selected`) so a server picker never blocks (the mod also never shows it under `-batchmode`). Visual check without a desktop window: run the game inside `gamescope --backend headless -W 1920 -H 1080`, screenshot with `GAMESCOPE_WAYLAND_DISPLAY=gamescope-0 gamescopectl screenshot out.png`, click/type via XTEST on its Xwayland `DISPLAY` (python-xlib). Xvfb + wined3d hangs at the splash. `--server`/`--env`/`--cfg` persist into the cfg file.
- `dotnet build` on net472 needs `ResolveAssemblyReferenceIgnoreTargetFrameworkAttributeVersionMismatch` (GameAnalytics.dll claims net48), otherwise Assembly-CSharp silently drops out.
- `stop-game.sh` uses `pkill -f 'CatanUniverse\.exe'`: don't run it from a shell whose command line contains that string. Same for `pkill -f mp-smoke`.
- **Testing a mod build without touching the installed one**: make a game copy whose big folders are symlinks (`CatanUniverse_Data`, `MonoBleedingEdge` -> the Steam dir; copy the exe, `UnityPlayer.dll`, `winhttp.dll`, `doorstop_config.ini`, `BepInEx/core`, `BepInEx/config/BepInEx.cfg`), put the build (`dotnet build -c Release -o <dir>`) into its `BepInEx/plugins/`, and run with `GAME_DIR=<copy> tools/mp-smoke.sh ... --first 4`. BepInEx takes its plugins from the copy's folder.
- Don't edit `mp-smoke.sh` while it runs (bash reads scripts incrementally).
- The game persists durable requests per user (`gs_default_<userId>.dat` in the prefix's LocalLow dir) and replays them at the next start; `mp-smoke.sh` deletes them in the instance prefixes before a run.
- GameAnalytics events go to gameanalytics.com only while the Official server is selected (or `Privacy.BlockAnalytics=false`).
