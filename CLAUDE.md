# Communitan — agent notes

Goal: Catan Universe (Steam, Unity 2022.3 Mono, **32-bit**, Proton) fully playable against a self-hosted server.
Plan + status: [PLAN.md](PLAN.md). Protocol specs: [docs/protocol/](docs/protocol/).

## Paths
- Decomp (read-only, 6k .cs, one dir per namespace): `$HOME/Documents/Decomps/Catan`
- Game: `~/.local/share/Steam/steamapps/common/Catan Universe` (AppID 544730)
- Proton prefix: `~/.local/share/Steam/steamapps/compatdata/544730/pfx`
- Player.log: `<pfx>/drive_c/users/steamuser/AppData/LocalLow/United Soft Media Verlag GmbH/Catan Universe/Player.log`
- BepInEx log: `<game>/BepInEx/LogOutput.log`

## Repo layout
- `Communitan/` BepInEx 5 plugin (C#, net472-ish, Harmony). Redirects NakamaConfig, logs traffic.
- `server/` Nakama TS runtime module + podman compose (Postgres + Nakama). Our reimplementation of the official backend.
- `docs/protocol/` specs extracted from decomp/captures (source of truth for server work).
- `tools/` scripts (build, install BepInEx, run game headless, capture).
- `browser-extension/` Chrome+Firefox MV3 extension: redirects the web game (catanuniverse.com/game/) to a custom server. `npm run build` / `npm test`; see its README.

## Protocol in one paragraph
Client uses Nakama .NET SDK 3.17 wrapped in a **GameSparks emulation layer** (`Nakama.Core/NakamaConnection.cs`, `NakamaInstance.cs`).
Every GS request → `client.RpcAsync(id = eventKey ?? requestType, payload = GS request JSON)`; RPC response payload = GS response JSON (`@class`, `requestId`, `scriptData`, `error`).
Auth: `AuthenticateEmailAsync` / `AuthenticateDeviceAsync` (session vars → AuthenticationResponse), re-login via `AuthenticateCustomAsync(sha256hex(token), create:false)`.
Server→client push = Nakama notifications whose `content` is a GS message JSON (`@class` `.ScriptMessage` + `extCode`, or `.ChallengeXMessage`); subject `single_socket` = kicked.
Matchmaker only for discovery: on matched, client joins match + room chat (channel = match id), calls `FinalizeMatchmaking`, then leaves the match.

## Conventions
- Spec format (docs/protocol): one entry per id, terse:
  `### KEY` `kind: LogEvent|LogChallengeEvent|Request` · `req: {field:type}` · `resp: {scriptData fields the client reads}` · `push: messages/extCodes triggered` · `src: File.cs:line` · `notes`. Unknown = `?`. Unused by game code = `dead`.
- Cite decomp as `Namespace/File.cs:line`. Never paste large code blocks into docs.
- Server code: TypeScript, one file per domain (`account.ts`, `lobby.ts`, …), RPC handlers registered from a table.
- Keep outputs and reports short; prefer tables/lists over prose.

## Server
- `cd server && npm run build && podman restart server_nakama_1` — rebuild + reload module (first start: `podman-compose up -d`).
- `podman logs --since 2m server_nakama_1 2>&1 | grep -E 'UNHANDLED|error'` — gaps/errors. Console: http://127.0.0.1:7351 (admin/catanadmin).
- `tools/rpc.sh <ID> '{"field":1}'` — call one RPC as a throwaway device user.
- Handlers: `src/<domain>.ts` exports `const <DOMAIN>_HANDLERS: GsHandlerTable`, add it to `gsTables()` in `main.ts`. Handler returns scriptData, `gsRaw({...})` for a full body, `gsFail(code)` for error. Push: `gsPushScript(nk, userId, extCode, data)`.
- Nakama runs RPCs in pooled VMs but InitModule in one: handler table is built lazily (`gsInit()` in dispatch.ts), never rely on InitModule state.
- Tests: `cd server && npm test` (smoke.sh, social.sh, mp, ranking; server must run). Ranking: `src/ranking.ts`, seasons in `data/seasons.json`.
- Static data: `server/data/*.json` (items via `tools/gen-items.py`, almanac via `tools/gen-almanac.py`), loaded with `dataLoad()` (store.ts). Smoke test: `server/test/smoke.sh`.
- Nakama JS: registrations/hooks must be literal calls inside `InitModule` (AST-extracted). RPC ids: `tools/gen-ids.sh`.
- Public status `COMMUNITAN_STATUS` (status.ts, core.md 5.4): reachable via `runtime.http_key` (`NAKAMA_HTTP_KEY`, public, default `catan-public-status`); `rpcDispatch` refuses all other ids without a session. JS runtime has no session start/end events.
- Tests against another server: `NAKAMA_HOST=http://127.0.0.1:17350 NAKAMA_CONSOLE=http://127.0.0.1:17351 NAKAMA_CONTAINER=<name>` (test/env.mjs).

## Commands
Details + gotchas: [tools/README.md](tools/README.md). Steam client must be running.
- `tools/install-bepinex.sh` once; `tools/build.sh` builds Release + deploys to `<game>/BepInEx/plugins/`
- `tools/run-game.sh --headless --timeout 90 --server Local|Official [--cfg Debug.AutoConnect=DeviceLogin]`; `tools/stop-game.sh`
- `tools/mp-smoke.sh [--mode Lobby] [--reconnect 100]`: two headless clients (`--instance 1/2`, own prefixes/cfg/logs under `~/.cache/communitan/`) play a full online match on Local via the game's AI (~8 min)
- Server list: `<game>/BepInEx/config/Communitan.servers.json`; cfg: `Toemmsen96.Communitan.cfg`
- Traffic: `<game>/BepInEx/traffic.jsonl` (`jq -c '[.dir,.id]'`); Unity log: `~/.cache/communitan/run/Player.log`
