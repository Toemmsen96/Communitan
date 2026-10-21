# Custom game modes (server-defined rule switches)

A server offers modes as JSON (`server/data/modes/*.json`). A mode picks from a fixed set of **rule switches** that
are implemented once as shared C# source (`rules/`) compiled into the mod (every client: lockstep, all clients run
the rules) and into the referee (L3 validates mode games like normal ones). No scripting: modes are data only.
Players start them from the custom lobby (host picks a mode) and from a Free Play queue per mode.

## Findings (decomp, 2026-10-21)
| Topic | Finding | Src |
|---|---|---|
| Dice | Generated at context entry on every client for every seat: `BaseRollDiceRule.GenerateDiceState` (dice stack: `DiceStack[0]`, else `CreateDiceRNG(NextUniqueId)`); `Apply` copies blob values; only consumer `MatchState.ResourceDiceSum` (7 test `BaseRobberRule.IsRobberShowUp`, transitions EndTurn_To_DistributeResource / _To_HandoverResourcesToRobber) | `BaseRollDiceRule.cs:47-59,88-94`, `CatanBase_RollDice_GameAction.cs:24-39`, `MatchState.cs:36-45`, `CatanBasicContextTransitionRules.cs:137-150` |
| Round start | `Base_NextPlayer` (Automatically, TurnNumber+1, local only) -> `Base_TurnEnded` (about to roll); active = `(TurnNumber+StartPlayerId)%n` -> round start = entering Base_TurnEnded with active == StartPlayerId. `ActionContextTransitions.CallEnterContextAction` runs before `ActionContext.Generate`, live and in history replay, not in `CreateActionsAfterLoadGame` (no double grant on rejoin) | `ActionContextTransitions.cs:377,391,642`, `GameLogic.cs:295,318-324,576-627` |
| Grant | `Base_DistributeResources` System action: `Inventory.Resources.Add`, no bank limit in the logic; log line + animation for free (keys = valid positions, cosmetic). RNG: `gs.CreateRNG(variant)` (no state advance, word-mixed in full mode; steal uses variant 0) | `BaseDistributeResourcesRule.cs:15-24`, `CatanGameLogEntryFactory.cs:233-255`, `CommonGameState.cs:134` |
| Safety | Start phase dice-free; nothing assumes non-7 rolls (win = VP only); AI never reads dice. 5-6 players: extra-round transition `:409-414` (modes: base 3-4 players first) | `BaseDistributeResourcesRule.cs:69-102`, `ActionContextTransitions.cs:365-369` |
| Delivery | Server keeps CreateChallenge `scriptData.gameInfo`, returns it flat in DETAILS_V3 / GAMESTATE_AND_ACTIONS_V3; client drops unknown keys; both arrive before `CreateGameStateForMP` (start + rejoin) -> mod stashes `ccsMode*` per challenge like `ccsRngMode` | `mp_match.ts:77-99`, `MultiplayerGameInformation.cs:736-900`, `GameSetupState.cs:59-79`, `RejoinState.cs:28-46`, `Communitan/ServerRng.cs:98-153` |
| UI | Lobby: `UiRework/ScenarioSettingsWithBots.cs:14-190` (clone a toggle into a Mode cycler; `ToGSData` postfix emits `ccsMode` to LOBBY_CREATE/UPDATE + CreateChallenge). Free Play: prefab `BoxButtonWrapper` with `_gamemodeData` -> clone per mode; `NakamaQueryConfig` adds `stringProperties.ccsMode` + query term | `BoxButtonWrapper.cs:21-24,146-150`, `PlayGame.cs:318-341`, `NakamaInstance.cs:704-783` |

## Design
- **Mode JSON** `{id, name, description, expansions:["CatanBaseGame"], players:{min,max}, gameInfo:{victoryPoints?,
  useShuffleMap?, friendlyRobber?, diceMode?}, rules:{...switches}}`; listed to clients via the public status / a
  `COMMUNITAN_MODES` RPC. Mode games are unranked (no ELO / season / leaderboards).
- **Switches** (`rules/ModeRules.cs`, static `Current` per process = one game, like the referee already assumes):
  | Switch | Hook |
  |---|---|
  | `dice.fixedSum` | `BaseRollDiceRule.GenerateDiceState` postfix: `d1 = CreateDiceRNG(NextUniqueId).Next(1,7)` clamped so `d2 = sum-d1` is a die; server `rngRollDice` (full) |
  | `roundGrant.count` (random base resources at round start) | `CallEnterContextAction` postfix appends one `Base_DistributeResources` System action, RNG `CreateRNG(0x4D4F4445 ^ TurnNumber)` |
  | later: `robber` (discard threshold, steal count), `buildCosts`, `startInventory` | rule prefixes / `CatanStaticState` after `SetupNewGame` |
  | `victoryPoints`, `useShuffleMap`, `friendlyRobber`, `diceMode` | server-side gameInfo only (no mod code) |
- **Server**: session keeps `gameInfo.ccsMode` (validated against `server/data/modes`), details/state add `ccsMode` +
  resolved `ccsModeDef`; caps token `modes-1` required to create/join/act in a mode game; mode overrides
  `mpFreeplayShuffle`; full mode: `rngRollDice` honours `dice.fixedSum`; MatchmakerAdd hook adds
  `-properties.ccsMode:/.+/` to tickets without a mode (plain Free Play never matches a mode ticket).
- **Mod**: stash `ccsModeDef` per challenge (OnMessageReceived, like ServerRng), set `ModeRules.Current` for that
  challenge only (official servers never). Lobby selector + Free Play boxes (G2).
- **Referee**: request carries the def (`session.gameInfo.ccsModeDef`), sets `ModeRules.Current` before the replay;
  dice check: sum == fixedSum.

## Milestones
| # | Scope | Status |
|---|---|---|
| G1 | `rules/` shared source (ModeDef, dice.fixedSum, roundGrant) in mod + referee; server modes data + delivery + caps gate + unranked + full-mode dice; robbers-only mode; harness `Debug.AutoPlayMode` (bots queue a mode) for headless bot games; referee validates mode games | ✅ see "G1 as built" |
| G2 | UI: lobby Mode selector, Free Play box per server mode, mode name on the versus screen; lobby validation + caps gate | ✅ see "G2 as built" |
| G3 | More switches (robber params, build costs, start inventory), more modes; expansions | ☐ |

Robbers only: `{dice:{fixedSum:7}, roundGrant:{count:2}, gameInfo:{useShuffleMap:false}, expansions:[base], players 3-4}`.

## G1 as built (2026-10-21)
| Part | What | Where |
|---|---|---|
| Rules (shared) | `ModeDef` POCO (+`Normalize`), `ModeRules.Current/Gate/Log/Patch`; linked `Compile Include="../rules/*.cs"` into both projects. `dice.fixedSum`: postfix replaces `DiceValues` with `d1 = CreateDiceRNG(NextUniqueId).Next(lo, hi+1)`, `d2 = sum-d1` (dice stack still pops: same on every client). `roundGrant.count`: postfix on `CallEnterContextAction`, only for `to == Base_TurnEnded`, `from ∈ {Base_NextPlayer, Base_StartPhase_NextPlayer}`, active == `StartPlayerId`; appends to `ContextState.SystemActions` before `Generate`, which numbers it (takes one uid: uids shift vs. a normal game, identical on all mode clients + referee). Key per player = smallest land tile next to one of its buildings (robber tile fallback) | `rules/ModeDef.cs`, `rules/ModeRules.cs` |
| Server | `data/modes/index.json` (`modes: [ids]`; Nakama JS cannot list a directory) + `data/modes/<id>.json`, validated (`modeCheck`: base game only, 2-4 players, ranges, known gameInfo keys), startup log. `modeResolve` = caps `modes-1` + known id, else 110 + `customErrorMessage`. MatchmakingRequest: `participantData.gameInformation.ccsMode` -> match record `gameInfo.ccsMode` + `ccsModeDef` (after `mpFreeplayShuffle`, mode `gameInfo` keys win). CreateChallenge: a Free Play match record (id = challenge id) decides the mode (client keys ignored/stripped), else the creator's `gameInfo.ccsMode` (custom/lobby); expansions + seat count checked against the mode. Session keeps both in `gameInfo` -> details/state/current-session return them flat. Gates: details/state (`mpRngGate`) and `GAME_ACTION_V3` need `modes-1` in a mode session. Full RNG: `rngRollDice` uniform over the pairs with the fixed sum (no dice deck). Unranked: `mpEloRows` + `rankingRecordGame` (`ranked && !modeOf(s)`): no ELO/placement/leaderboard/season/guild; XP + profile statistics still count | `server/src/modes.ts`, `mp_match.ts`, `mp_game.ts`, `mp_rng.ts`, `ranking.ts` |
| Matchmaker | MatchmakerAdd before-hook (after `mpCapMatchmaker`): ticket without `ccsMode` gets `-properties.ccsMode:/.+/`; with one: any client `ccsMode` term replaced by `+properties.ccsMode:<id>` (bad id -> "invalid"), min = max = clamp(minCount, mode players). Status count keys get `|<mode>` (mod `MatchmakingStatus.ModeKey` too) | `modes.ts modeMatchmaker`, `status.ts` |
| Listing | status `gameModes: [{id,name,description,expansions,players}]` (`modes` was taken: per-queue counts); RPC `COMMUNITAN_MODES` (public like the status, registered literally, plain JSON or GS) = full definitions | `status.ts`, `modes.ts rpcModes`, `main.ts` |
| Mod | `GameModes.Patch` (ModeRules + own patches; `PatchesOk` -> caps `modes-1` appended by `ServerRng.AddCaps`, comma list). Stash: `OnMessageReceived` prefix, details/state (start + rejoin) with `ccsModeDef` on a custom server -> `ModeRules.Current`; `Gate` = custom server + that challenge is the running MP game; a details/state without it clears. Queue carrier: mode per `MultiplayerGameInformation` (ConditionalWeakTable) survives `Copy()`/copy ctor (the match state machine queues copies), cleared by `Reset()`, set from `UpdateFromGSData` (`ccsMode`), emitted by `ToGSData`; `NakamaQueryConfig` ctor/`ToString` postfixes add `stringProperties.ccsMode` + `+properties.ccsMode:<id>`. Harness cfg `Debug.AutoPlayMode` (QuickMatch). Verbose (harness) log: `Modes: round grant ...`, `Modes: roll ...` | `Communitan/GameModes.cs`, `Harness.cs`, `Plugin.cs` |
| Referee | `Replay` parses `session.gameInfo.ccsModeDef` (mode without def = unsupported), sets `ModeRules.Current` per replay (reset in `finally`), verdict `mode` + `stats.modeRolls/modeGrants`. Dice check: with a fixed sum the first two dice must sum to it (also in full); off/seeds keep the exact comparison | `referee/Replay.cs`, `Checks.cs`, `Shims.cs` |
| Tools | `tools/bots.sh --game-mode ID`, `tools/mp-smoke.sh --game-mode ID` (summary: roll sums, round grants per client, grants identical across clients) | `tools/` |

Decisions that differ from the design above:
- Round start also requires `from` = a next-player context: `Base_TurnEnded` is re-entered in the same turn after a dev card
  played before rolling (knight/monopoly/inventor/free roads), which would grant twice. The first turn after the start
  phase counts as round 1.
- The mode list needs `modes/index.json`; status uses `gameModes`. Lobby (`LOBBY_CREATE/ACCEPT`) caps checks: G2 (the
  CreateChallenge + details/state/action gates already stop unmodded clients from playing a mode game).
- Only `Base_RollDice` dice (`GenerateDiceState`) are fixed; C&K (`GenerateCakDiceState`) is not hooked (modes are base only).

Evidence:
- `server/test/modes.test.mjs` (`npm run test:modes`, own pod, rng full + enforce): 31/31 — listing, matchmaker pools (3
  robbers tickets asking for 2 -> one 3-player match; 2 plain tickets match each other; unknown mode matches nobody),
  MatchFound/details/state carry the mode, useShuffleMap false despite `CATAN_SHUFFLE_FREEPLAY=on`, caps gate (110) on
  MatchmakingRequest/details/state/action/CreateChallenge, 20 server rolls all sum 7, result increaseElo 0 + no
  leaderboard record, injected ccsMode on a plain match ignored, custom CreateChallenge validation. Other suites green there.
- Referee selftest: new fixture `bfeb3598` (recorded robbers game, full RNG) ok + recorded ranks, all tampers caught, plus
  "roll with another sum" -> invalid `dice sum 12 in a mode with fixed sum 7`; older fixtures unchanged.
- Real game (`tools/mp-smoke.sh --players 3 --game-mode robbers --timescale 4`, own pod, `CATAN_SERVER_RNG=full`,
  `CATAN_SERVER_RULES=enforce`, own referee): finished in ~4 min, all 3 clients got the result; on every client 280 applied
  rolls all sum 7, 24 round grants x 3 players x 2 cards, identical on all clients; local rolls (before server dice) sum 7
  too; RNG state mismatches 0; referee inline + post-game `ok` (383 actions, `modeRolls` 216, `modeGrants` 24); results
  increaseElo 0, no ELO leaderboard records. 0 exceptions, 0 server errors.
- Second real game, `CATAN_SERVER_RNG=off` (client dice, referee compares them exactly with its own generated dice) +
  `--reconnect 100`: finished (2 remaining clients got the result), 544 rolls all 7, 46 grants identical; the relaunched
  client rejoined (history replay: its 11 replayed grants identical to the others', no extra grant from
  `CreateActionsAfterLoadGame`, next live uid matched) but was then AFK-kicked: at `--timescale 4` the 90 s turn timer ran
  out 3x during the ~40 s restart (`AFK_3X_TURNTIMER`, unrelated to modes; use timescale 1 for reconnect tests). Referee
  inline (897 checks) + post-game `ok` (788 actions). Server suites on rng off: mp 94, modes 31, referee 47, smoke OK.
- Not verified: lobby/custom mode games with real clients (needs the G2 selector), a full reconnect with the client
  playing on after rejoin, 4-player mode games, unmodded client trying to join (server gates tested by protocol only).

## G2 as built (2026-10-21)
| Part | What | Where |
|---|---|---|
| Mode list | `ModeList`: `COMMUNITAN_MODES` over HTTP with the public status key (like the server list), on server change / login / every 10 min; custom servers with the `modes-1` patches only (Official: always empty, no UI change) | `Communitan/GameModesUi.cs` |
| Lobby selector | `ScenarioSettingsWithBots.UpdateWithScenarioAndSetSingleplayer` postfix: clone of `_randomMapToggle` as row 0 `Communitan_ModeToggle` ("Game mode: Standard / <name>", checkmark = mode on, its (?) popup = description); click cycles Standard -> modes -> Standard, `GameModes.SetQueued` + `Lobby.UpdateGameInfoIfHost` (ToGSData `ccsMode` -> LOBBY_UPDATE_GAME_INFO / LOBBY_START_GAME / CreateChallenge). Only for the lobby host, base-game scenarios (switching expansion clears it). Mode `gameInfo` keys are shown on the game's controls and locked (prefix unlocks before the game recomputes them). Column has a fixed height: spacing shrinks to fit the extra row | `GameModesUi.cs` |
| Free Play boxes | `Freeplay_Box` (BaseGame data, button -> `PlayFreeMatch`) is switched by `Content`'s `ObjectFreematchToggle.OnEnable` without its own OnEnable -> postfix on `ObjectFreematchToggle.UpdateEnable` + 0.5 s poll: one clone per mode right after it (`Communitan_ModeBox_<id>`, mirrors its active state, Multiplayer state only), title = name, info strip "Game mode · 3-4 players", (i) -> dialog with the description. Play -> `BoxButtonWrapper.PlayFreeMatch` prefix sets `GameModes.PendingFreePlay`, `SetFreeMatch` postfix queues the mode (G1 matchmaker path) + clamps players to the mode | `GameModesUi.cs`, `GameModes.cs` |
| Mode name | versus screen: `VersusReferences.SetupContent` postfix appends " · <name>" to the map line; invite dialog (`MatchInvitedHandler.ShowInvite` replaced while the lobby has a mode) adds name, players, description; overlay line (own canvas, game font, bottom left above the server info line): lobby (all members) / searching / loading + in game | `GameModesUi.cs` |
| Server | Lobby keeps `ccsMode` + the mode's gameInfo overrides (no def; CreateChallenge resolves again). `LOBBY_CREATE` / `LOBBY_UPDATE_GAME_INFO` / `LOBBY_START_GAME`: `modeResolve` (caller's caps + known id), non-base expansions drop the mode, every member must have sent `modes-1` with its last lobby request (`l.modeCaps`), else 110 naming them; start also checks seats (sortedPlayerIds incl. AI) against `players`. `LOBBY_ACCEPT` of a mode lobby without `modes-1` -> 110. Unranked etc. as G1 | `server/src/modes.ts` (`modeLobby*`), `mp_lobby.ts` |
| Harness | cfg `Debug.AutoPlayUi` (+ `AutoPlayMode`): QuickMatch clicks the mode's Free Play box, HostLobby opens the lobby's Free match scenario screen and clicks the selector; `mp-smoke.sh --ui`, `--mode Lobby --game-mode`; env `CATAN_SHOTS=1` + `HEADLESS_METHOD=gamescope` = screenshots | `Harness.cs`, `tools/mp-smoke.sh` |

Decisions:
- The mode picker is a cycler (one cloned toggle row), not a dropdown: no dropdown prefab in that panel; works for any number of modes.
- Lobby expansion mismatch drops the mode instead of failing (the host's next update fixes the UI); caps/unknown/seat errors fail with 110 + message.
- Lobby members' caps are those of their last lobby request (an old client that joined a plain lobby blocks switching to a mode).

Evidence (own pod, test mode `duel` = robbers rules for 2-4 players added to its data dir only):
- `server/test/modes.test.mjs`: 50/50 (rng full and off; +19 lobby checks: create/accept/update/start gates, invite/update/start
  pushes carry `ccsMode`, expansion switch drops it, member without `modes-1` named in the 110 message, seat count, lobby
  CreateChallenge -> details with def). Other suites green on rng full (smoke, social, mp 119, ranking 81, status 21,
  entitlements 21; referee skipped, rules off) and mp on rng off.
- Real games, final build from a separate game copy (`GAME_DIR`), never the user's install: `mp-smoke.sh --mode Lobby
  --game-mode duel --ui` (host clicks the selector, joiner sees invite + lobby line) PASS twice: 177 rolls all 7, 30 round
  grants identical, 0 RNG mismatches, versus "THE FIRST ISLAND · ROBBERS DUEL"; `mp-smoke.sh --players 3 --game-mode
  robbers --ui` (3 clients click the Robbers Free Play box) PASS: 388 rolls all 7, 33 grants identical. 0 exceptions, 0 server errors.
- Screenshots (gamescope): mode boxes next to Free match, lobby selector row, versus map line, in-game line.
- Not verified: mouse clicks by a person (the harness invokes the same `onClick`/`isOn`), other resolutions/aspect
  ratios, the (i)/(?) description popups, an unmodded client in a mode lobby (server gates tested by protocol only),
  Official server menus (code paths gated by `ServerList.IsCustomSelected`, not run).

