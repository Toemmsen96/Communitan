# Level 3 anti-cheat: server-side rules ("referee"), per server: `CATAN_SERVER_RULES=off|audit|enforce`

Builds on [server-rng.md](server-rng.md) (L1 seeds, L2 full). L2 makes randomness server-owned but every other payload
field is still trusted (costs, positions, chosen resources, trades) and the result comes from one client's `GAME_WON`.
L3: the server runs the game's **own** rules code headless, replays every action, rejects/flags actions the rules would
not have produced, owns the result, and **kicks players caught sending invalid game data**.

## Findings (decomp + runtime spike 2026-10-21)
| Topic | Finding | Src |
|---|---|---|
| Unity coupling | 46/652 logic files use UnityEngine; on the action path only: `Debug.Log*`, `Application.isPlaying`, `Resources.Load<TextAsset>` (rules, scenarios), `TutorialController.Instance`, `CommonNetworking.Instance` (map seed), longest-road `PlayerController.DataCache`, board cache `ThemesetReferenceManager` | `ActionContext.cs:293`, `CatanGameRulesSerializer.cs:18`, `CommonGameStateSerializer.cs:253,272`, `CatanBase_BuyDevelopmentCard_GameAction.cs:32`, `BaseShuffleMapRule.cs:132`, `BaseCheckLongestRoadRule.cs:109,133` |
| Runtime | `Assembly-CSharp.dll` loads on .NET 8 (all 8616 types). Unity InternalCalls can't even JIT on CoreCLR -> Unity DLLs rewritten offline (Cecil: ECall bodies -> default). Harmony needs `GLIBC_TUNABLES=glibc.rtld.execstack=2` | spike |
| Game start | `CatanGameComponent.CreateGameStateForMP` (scenario Thrift TextAsset `scenarios/catan/<id>` + seeds + gameInfo static state + `ScenarioSetup.MapShuffleMode` + colors) -> `CatanGameLogicSetup.SetupNewGame` (TextAsset `rules/catan/CatanGameRules`) -> `new GameLogic(state, CatanGameLogicExtension)` | `CatanGameComponent.cs:402-470`, `CatanGameLogicSetup.cs:11-38` |
| Replay | Rejoin path works headless: `StartApplyHistory`, per action `ActionContext.ApplyGameAction` (+ System/Automatic actions applied locally, never sent) -> `FailedInvalid/MissingPrevious/Obsolete` | `GameLogic.cs:534-600`, `ActionContext.cs:191-232` |
| Validation | Game `IsValid` is weak (positions, costs, trades, Inventor unchecked); a forged corner passed `IsValid` and crashed `Apply`. Working check: compare the received action with the game's own generated reference (`ActionContext.GetGameActionReference`): fixed fields equal, choice fields in the allowed set | `BuildRoadRule.cs:10`, `TradeFinishRule.cs:7`, `BuyDevelopmentCardRule.cs:8` |
| Result | `Base_WinGame` with `WinRule.GetWinners`; WIN_LOSE built client-side from VP, sent by one human with `ITS_THE_FINAL_GAMESTATE` | `WinRule.cs:9,77`, `StatisticsUtils.cs:237`, `WinGameVictoryStateBase.cs:76-100` |
| Kick | Server `mpKick` push `GAME_PLAYER_WAS_KICKED` -> others: popup + seat becomes `PermanentAI`, host runs it, game continues (already-applied actions stay). Kicked client always shows "disconnected too long"; reason text only at menu rejoin (`wasKickedReason`, unknown string -> UNKNOWN) | `PlayerLeftHandler.cs:91-170`, `CatanGameComponent.cs:184-230`, `KickedBecauseDisconnectHandler.cs:38-56`, `KickedFromChallenge.cs:19-22` |
| Spike result | 7 finished base games (1637 actions, rng off, 3 shuffled maps): 0 rejected, winner + VP order = recorded ranks, ~0.7 s/match incl. process start. Full-RNG session: L2 word mix + dev-card redraw ported -> RNG identical to clients for 29 mixes | spike |

## Design
- **Referee** = .NET 8 service `referee/` (C#) next to Nakama (compose profile `referee`, internal network only). Loads the
  **operator's own game install** at setup time: `tools/referee-setup.sh <game dir>` rewrites the Unity DLLs and extracts
  the rules/scenario TextAssets into `referee/game/` (git-ignored). **No game DLL or asset is ever committed or released.**
- Shims (Harmony, in the referee): the coupling rows above. One `GameLogic` per session; static game state
  (`GameActionMapping`, `HexGridLinks`, dev-card id counter) -> one session at a time per worker process (pool).
- Reuses the L2 logic (server dice in blobs, per-action word mix, draw re-picks) so its state equals the clients'.
- API (JSON over HTTP, called with `nk.httpRequest`): `POST /v1/replay {session, actions[]}` -> `{supported, ok, winners,
  ranks[{playerId,vp,rank}], invalid?{uid,playerId,actionId,reason}, desync?{uid,result}}`; later `POST
  /v1/sessions/{id}/actions` (inline). `GET /healthz`.
- **Verdicts:** `invalid` = an action of player P differs from the reference (wrong cost/position/choice) or fails the
  rules -> P cheated. Since 2026-10-21 also a player action the rules never offered (no reference, uid > `NextUniqueId`: e.g. a "free build" the player can't afford). `desync` (exception in Apply) = referee and game disagree, never treated as cheating
  (logged as a bug). Unsupported scenario/expansion -> `supported:false`, server falls back to L2 behaviour.
- **Server (`server/src/referee.ts`)**: `audit` = verdict stored (`l3_verdicts/<challengeId>`) + logged, nothing else;
  `enforce` = in addition: cheater gets `kicked:"INVALID_GAME_DATA"` (+ `ccsKickReason` in the push), ranks/ELO come from
  the referee (cheater last, loses as if kicked), cheat event recorded (`l3_cheats`, per user) for the operator.
- **Mod**: shows "removed: invalid game data" for `ccsKickReason` (patch `KickedBecauseDisconnectHandler`/
  `ShowYouWereKickedMessage`); others see the game's normal "player left, AI takes over".
- Status `rules: off|audit|enforce` in `COMMUNITAN_STATUS`; server list label.

## Milestones
| # | Scope | Status |
|---|---|---|
| M1 | Referee service (port of the spike), setup script, `/v1/replay`; server calls it at `GAME_WON` (before ranking/ELO), `audit` + `enforce` result override + post-game cheat record; base game only | ✅ see "M1 as built" |
| M2 | Inline: one live `GameLogic` per session, validate each `GAME_ACTION_V3` **before** ack/relay (sender applies only after the ack, so a rejected action is never applied anywhere) -> mid-game kick + AI takeover | ◐ built as full replay per action (no live `GameLogic` yet), see "M2 inline as built"; real 2-client game passed 2026-10-23 |
| M3 | Mod kick message; status/server-list label; operator view of `l3_cheats` | ✅ `KickReasonText.cs` (dialog after a live kick or at next login), server list "rules audited/enforced" (mod + extension), `tools/cheats.sh`, HOSTING.md section |
| M4 | Expansions (Seafarers, C&K, Inka, Explorers, Rivals): shims + per-scenario `MapShuffleMode` table, one by one | ☐ |
| - | Cheap TS-only checks (any time): fixed costs from `CatanGameRules`, final state VP vs WIN_LOSE | ☐ |

## M1 as built (2026-10-21)
| Part | What | Where |
|---|---|---|
| Setup | `tools/referee-setup.sh [game dir]`: Cecil stub of `UnityEngine*.dll`, game assemblies copied (Mono framework ones skipped), TextAssets `rules/catan/CatanGameRules` + base-game `scenarios/catan/<id>`, `shufflemodes.json` read from the `ScenarioSetup` assets (85 setups; base: firstisland 9 Screw, baseharbormaster 9, oreforwool 0, firstisland_extended 11), build -> `referee/bin/publish`. All output git-ignored | `referee/stubber`, `referee/setup/extract_assets.py` |
| Service | `HttpListener` (no ASP.NET), one request at a time, watchdog exits the process. Request `actions[]` = `{a: blob, w?: rng word, by?: sender}`. Verdict extras: `finished`, `stats`, `ranks[].seat`, `invalid.seat/senderId` | `referee/Server.cs`, `Replay.cs` |
| Checks | Default: every field of the received action equals the reference. Choice fields (calibrated: the only fields that differ in 1500+ honest actions, `REFEREE_CALIBRATE=1`): positions in `ValidPositions`, piece type per action, rob target in `PlayersList`, discard/trade cards owned, Monopoly/Inventor choices, bank offer (rest by the game's `IsValid` with the verified ratio). Dice: fixed in off/seeds, server dice (range only) in full. Bought dev card: fixed in every mode (full: the blob carries the pre-redraw top, identical on honest clients; a forced card type = modified client, caught live 2026-10-21 for a `/ovrddevcard Victory` cheat, 0 false positives on bot games). Card ids never compared | `referee/Checks.cs` |
| Verdicts | `invalid` = check failed or `IsValid` false. No reference + uid < `NextUniqueId` = ignored like clients do (`stats.obsolete`/`dups`); uid > next = `invalid` "not offered by the rules" (free-build cheat caught live 2026-10-21; 0 in honest fixtures/bot games); exception in Apply, not finished = `desync`. Server: a `GAME_WON` whose replay applied every action cleanly but is not finished (no `Base_WinGame`) = false claim -> the claimer is the cheater (not when other humans left/were kicked) | `Replay.cs` |
| Server | `refJudge` before the result mutation (`nk.httpRequest`, 15 s), verdict reused per session gen; `refRanks` (enforce): ok -> referee ranks, invalid -> client order for the others + cheater last; `refPunish`: `l3_cheats`/<challengeId> (user-owned, no read), `pres.kicked`, kicked pointer -> menu `wasKickedReason` | `server/src/referee.ts`, hooks in `mp_game.ts` (`mpWon`, `mpEloRows`, `mpAction`, `mpActions`) |
| Status/compose | `rules` in `COMMUNITAN_STATUS`; compose env `CATAN_SERVER_RULES` (default off), `CATAN_REFEREE_URL` (default `http://referee:8790`), profile `referee` (`dotnet/runtime:8.0`, mounts `referee/bin/publish` + `referee/game`, no ports) | `server/compose.yml` |

Decisions that differ from the design above:
- Cheater = the **sender** of the invalid action (`s[]` next to the blobs in `session_actions`, stored while rules are on), falling back to the seat owner. AI seats (host) and turn-timer actions are sent by another client, and a forged `PlayerId` must not frame its victim.
- Post-game kick: no `GAME_PLAYER_WAS_KICKED`/`ccsKickReason` push (game is over); the reason reaches the client via `GAME_GET_CURRENT_SESSION.wasKickedReason` (unmodded: "UNKNOWN"). Push + mod text: M2/M3.
- Invalid verdict: the referee stops at the forged action, so the other players keep the client's order (the game continued with the forged action applied everywhere).
- `l3_verdicts/<challengeId>` holds `{gen, mode, verdict, cheater?, claimed}`; a lobby rematch (same challenge id, new gen) overwrites it.
- Seats not in `humans` are created as `PermanentAI` (difficulty Normal); seats kicked mid-game stay `Human` in the replay.

Evidence: `referee/test/run.sh` (8 recorded fixtures, sanitized): 7 finished matches ok + recorded ranks, 10 tamper kinds -> `invalid` for the right seat/sender, full-RNG session 853b18c4 -> `invalid` at seat 2's first purchase (that player used a dev-card override cheat); `server/test/referee.test.mjs` (enforce + full on a throwaway pod): result override, cheater last + `l3_cheats` + kick reason, unsupported scenario unchanged; all server suites green there. Real game: `tools/mp-smoke.sh --server <pod> --first 6` (2 clients, base, `CATAN_SERVER_RNG=full`, enforce): GAME_WON -> referee ok in 263 ms (290 actions, 276 word mixes, 6 dev-card re-draws), ranks = clients' WIN_LOSE. Compose-style referee container (`dotnet/runtime:8.0`, same pod) verified with `test:referee`.
Not covered yet: trade consent (GAME_TRADE), Inventor bank stock, longest road/army edge cases beyond the recordings, 5-6 player scenario (no recording), referee pool.

## M2 inline as built (2026-10-21)
- `enforce` only: `mpAction` (after `rngAccept`) -> `refCheckAction` POSTs the stored log + the new action (`by` = sender, `w` in full mode) to `/v1/replay`. `invalid.uid` = the new action's uid -> error 46, not stored, not relayed; `refKickInline`: `mpKick(INVALID_GAME_DATA)` (`GAME_PLAYER_WAS_KICKED` to the others, kicked pointer), `l3_cheats`/<challengeId> with `inline:true`. Later actions of the kicked sender: 46.
- Fail open (action accepted, `s.l3` = reason, session no longer checked inline, post-game replay still judges it): referee error/timeout (once per session, not 15 s per action), unsupported scenario, desync, invalid verdict for an older action. The referee's normal mid-game verdict `desync uid -1 NotFinished` is **not** a desync (bug fixed: it disabled inline checks on the first action).
- Cost: one full replay per action, O(n) per action. Measured (own referee, 2 players): +~25-30 ms median per action at 60-150 actions (RPC median 6 ms without, 32-38 ms with); full-game replay 65 ms (226 actions, 2p) - 160 ms (357 actions, 3p). The referee answers one request at a time: concurrent games queue. Next step: live `GameLogic` per session (`/v1/sessions/{id}/actions`).
- Evidence: `test:referee` inline section (rules=enforce + rng=off): 150-action honest prefix of a recording accepted, nothing kicked, `s.l3` unset; forged dice of seat 1 at action 96 -> 46, `nActions` unchanged, sender kicked, `GAME_PLAYER_WAS_KICKED` to seat 0, not relayed, `l3_cheats` inline record. mp suite (synthetic blobs) fails open as `unsupported`; referee down -> all accepted, `s.l3` = referee error.
- Gaps: an action that throws in `Apply` still reads as `desync` -> accepted and inline checks stop for that session (uid > `NextUniqueId` is `invalid` since 2026-10-21, and a false win claim is caught post-game). A blob the server's Thrift walker can't parse (`rngParse`, e.g. trailing bytes) is not checked inline (post-game replay still sees it). Real clients: 2026-10-21 two live dev-card cheats (CatanCheats `/ovrddevcard`) kicked inline (Victory, Monopoly); 2026-10-23 `tools/mp-smoke.sh --server <pod> --first 6 --reconnect 150` (base 2P, rng full + enforce, client 2 killed and rejoined at 191 s): PASS, every action checked inline (no fail-open), 0 RNG mismatches over 113 rolls/turn ends, GAME_WON -> referee ok (240 actions, 73 ms).

## Open issues
- L2 rejoin (`853b18c4`): recorded with an older mod (draw re-picks not yet patched); its rejoin fails "Apply history detect Obsolete Action" and the referee reads it as `desync`, never `invalid`. Games with the current mod rejoin and replay `ok` (2026-10-23 run above). Old unfinished full-mode games stay un-rejoinable.
- A failed rejoin loops: the client retries `GAME_GET_GAMESTATE_AND_ACTIONS_V3` every 25 s and never returns to the menu (seen 2026-10-23 with a 2-day-old session on a reused test pod: the harness rejoined it instead of the new match). Server side: sessions whose players are all gone are not ended while Nakama is stopped. Todo: end/abandon such sessions (kick timer on wake-up) so `GAME_GET_CURRENT_SESSION` stops offering them.
- Hidden information stays visible to modified clients (full state on every client); would need server-owned state (not planned).
- Licensing: the referee only runs with a legally owned game install on the server host.
