# Multiplayer protocol (matchmaking, lobby, in-game, reconnect, results)

Source: decomp at `$HOME/Documents/Decomps/Catan`. All requests below go through the GS emulation layer: RPC id = `eventKey` (LogEvent / LogChallengeEvent) or request class name (`MatchmakingRequest`, `CreateChallengeRequest`, `AcceptChallengeRequest`); payload = GS request JSON; response = GS response JSON (`Nakama.Core/NakamaConnection.cs:311-320,495-511`). See CLAUDE.md for the envelope.
Notation: `LE` = `LogEventRequest_*`, `LCE` = `LogChallengeEventRequest_*` (adds `challengeInstanceId`, response class `.LogChallengeEventResponse`). Both use the same RPC id (the eventKey), so the server tells them apart by `@class` or by payload. "scriptData" = GS `scriptData` object in the response. `NS` = `Common.Net/NakamaSender.cs`, `NL` = `Common.Net/NakamaListener.cs`.
Error response shape: `{"@class":".<X>Response","requestId":..,"error":{"errorCode":<int>,"customErrorMessage":..,"errorUri":..}}` (`Common.Net/Error.cs:15-30`). Codes used here (`Common.Net/ErrorCode.cs`): TimeOut 11, PlayerOffline 22, PlayerIsIngame 23, ChallengeClosed 24, PlayerWasKickedFromChallenge 46, UnableToUpdateMultiplayerProgress 110, IncorrectLastAction 111.

---------------------------------------------------------------------
## A. Architecture summary

1. **Peer-replicated lockstep, not server-authoritative.** Every human client runs the full `GameLogic` locally (`CatanServerComponent`/`GameLogic.Current`). The server never interprets game rules; `gameActionState` is an opaque base64 Thrift blob (E).
2. **Determinism** comes from three seeds created by the challenge creator and stored by the server: `seed`, `diceSeed`, `colorSeed` (`Common.Net/HandShakeStartState.cs:46-61`). Clients receive them via `GAME_GET_GAME_DETAILS_V3` / `GAME_GET_GAMESTATE_AND_ACTIONS_V3`; **every client incl. the creator uses only those** (`GameSetupState.cs:66-68`, `RejoinState.cs:39-41`; the creator's own values are never applied locally), so the server may replace them (ours: `CATAN_SERVER_RNG=seeds`, docs/design/server-rng.md).
3. **Each client sends its own actions** (`GAME_ACTION_V3`) and applies other players' actions received as `GAME_ACTION_PLAYED` pushes (`Common.Net/Multiplayer.cs:177-196`, `NL:649-683`). Local echo is skipped by `ActionPlayedByPlayerIdx == localIdx`.
4. **Host client** (`hostIdx` = seat index, server-assigned, returned in details/ping/state responses and in pushes `GAME_PAUSED`, `GAME_PLAYER_WAS_KICKED`, `ACCOUNT_PLAYER_DISCONNECTED`) only matters for AI seats: the host runs AI controllers for AI and kicked/replaced seats and sends their actions (`Multiplayer.cs:ShouldSendToGameSparks`, `Catan.Unity.Components/CatanGameComponent.cs:265-303`). When `hostIdx` changes the old host stops its AIs, the new host starts them (`TaskSwitchHost`). Request `GAME_CHANGE_HOSTIDX` is dead: the server must elect the host itself.
5. **Server must store per challenge**: gameInfo (+ sorted player ids = seat order), 3 seeds, ordered list of action blobs (`gameActions`), per-seat `lastPlayed` action counters, latest context (`contextId`, `previousContextId`, `contextSwitchId`, `nextUniqueId`, `lastPlayedUniqueId`, `lastPlayedActionIdContext`), hostIdx, per-player presence (in-game/paused/kicked + kick timers), muted-player pairs, ready/started sets, challenge state (ISSUED/RUNNING/WAITING/COMPLETED), final state blob + stats.
6. **Ordering/validation** is the only server-side "game logic": `GAME_ACTION_V3` carries `ACTION_ID` (= `NetworkSyncId` = sender's `ContextSwitchNextUniqueId`, `ActionContext.cs:61-66`) and `ACTION_OWNER_INDEX`. Server compares to its stored per-seat counter and replies `IncorrectLastAction` (111) on mismatch. Client retries 3x (except 111/24/46), serialised 1 request at a time, `NakamaActionQueue.cs`.
7. **Relay**: server pushes `GAME_ACTION_PLAYED` / `GAME_ACTION_TURNTIMER_PLAYED` / `GAME_TRADE` / `GAME_MULTICAST_TURNTIMERS` / `CHAT_EMOJI` to the other humans of the challenge; trades are not stored. Game chat is a plain Nakama room channel (id = challengeId).
8. **Turn timers** run on clients. When a timer expires the *player's own client* (or the host for AI seats) sends `GAME_ACTION_TURNTIMER` (delay 2s + 1s*seatIdx, `NakamaActionQueue.cs:88-100`). Server only stores/relays; it supplies defaults via `GAME_GET_TURNTIMERS` and a periodic multicast (host -> all) of current timers.
9. **Liveness**: client pings `GAME_PING_V3` every 25 s (`NakamaPing.cs`); client assumes server timeout 35 s. Server owns presence: `GAME_PLAYER_LEFT`/`RETURNED`/missed pings -> `GAME_PAUSED` push (+kick timer), kick -> `GAME_PLAYER_WAS_KICKED` (seat becomes AI), AFK (3 timed-out turns) -> `GAME_PLAYER_AFK_KICKED`.
10. **Desync repair**: ping response carries `allLastPlayedActionsPerPlayer`; client compares to its own, then `Reconnect` (fetch `GAME_GET_GAMESTATE_AND_ACTIONS_V3`, replay missing actions) or `Reload` (`NakamaPing.cs:80-135`).
11. **Rejoin/reconnect**: `GAME_GET_CURRENT_SESSION` -> `GAME_GET_GAME_DETAILS_V3` -> `GAME_GET_GAMESTATE_AND_ACTIONS_V3` (replay all `gameActions` into a fresh `GameLogic`) -> `GAME_PLAYER_RETURNED`.
12. **Finish**: exactly one human client (first human winner, else the first human loser) sends `GAME_WON` with `WIN_LOSE.win_lose[]` + final state. Server computes ELO/XP/karma, closes the challenge, pushes `GAME_MULTIPLAYER_RESULT` to all participants. `GAME_WON_BY_SERVER` is the server-initiated variant (e.g. all other humans gone).
13. **Matchmaking** uses the real Nakama matchmaker for discovery only; the server-side contract after match is `MatchmakingRequest` (per client) -> `MatchFoundMessage` push -> creator calls `CreateChallengeRequest` -> others find the session by polling `GAME_GET_CURRENT_SESSION` (see B1).
14. **Dispatch whitelist (important)**: the client only routes a subset of pushes (`Nakama.Core/NakamaInstance.cs:547-702`): classes `FriendMessage, TeamChatMessage, AchievementEarnedMessage, ChallengeIssuedMessage, OnChallengeJoined, ChallengeAcceptedMessage, ChallengeChatMessage, SessionTerminatedMessage, ScriptMessage` and ScriptMessage extCodes listed in section C. Everything else (ChallengeStarted/Drawn/Lost/Declined, MatchNotFound/Updated, BIG_GAME_*, TOURNAMENT_PLAYER_UPDATE) is silently dropped.

---------------------------------------------------------------------
## B. Flows

### B0. Push envelope
Notification `content` = JSON `{"@class":".ScriptMessage","extCode":"<EXT>","data":{...}}` (`GameSparks.Api.Messages/ScriptMessage.cs`: `Data` = `data`). Non-script messages use `@class` only (`.ChallengeIssuedMessage` etc.). Subject `single_socket` -> client terminates session (`NakamaConnection.cs:638-646`). On login the client also pulls stored notifications (`ListNotificationsAsync`, `NakamaConnection.cs:568-635`), so undelivered pushes should be persisted as Nakama notifications (persistent=true).

### B1. Quick match / Auto match (Nakama matchmaker)
State machine: Idle -> StartMatchmaking -> WaitForMatch -> (StartHandshake | Handshake) -> GameSetup -> WaitForGameLogic -> Game (`Common.Net/MatchState.cs`, `MatchConnectStateMachine.cs`).
1. UI -> `MatchStartState.Start`: cancels stale tickets, `NakamaHandler.AddMatchmakerAsync(gameInfo)` (`Nakama.Core/NakamaInstance.cs:704-780`). First calls RPC `SendGetBlockedAndFriendPlayerIds` (account doc) for `blocked`/`friends`.
2. Client calls `socket.AddMatchmakerAsync(query, min, max, stringProps, numProps)`. Quick and auto match use the same code path (`MatchStartState.cs:StartAutoMatch/StartFreeMatch`). Query/properties (`Common.Net.Nakama/NakamaQueryConfig.cs:117-190,462-527`):
   - query = `+properties.matchType:<QUICK_MATCH|AUTO_MATCH> +properties.expansions:<regex> +properties.scenarios:<regex> +properties.skill:>=S-t +properties.skill:<=S+t [karma range, +only if karmaOnly] +properties.appVersion:<ver> [+tournamentId|+friends|+guild|+seasonId] (-seasonId:.+ if not season)`; `t` = 100 -> 200 -> 300.
   - stringProperties: `matchType, expansions (space list), scenarios (space list), karmaOnly, friendsOnly, guildsOnly, [tournamentId, seasonId, rivalsThemeSetWishlist, friends, guild]`; numericProperties: `skill (ELO), karma, appVersion`.
   - min/max from gameInfo (`minPlayers`,`maxPlayers`; e.g. 2, 3-4, 5-6).
3. Auto-match only: every 60 s `MatchWaitState` cancels the ticket and re-adds with next threshold index (`MatchWaitState.cs:120-186`); 3 thresholds.
4. Server: Nakama matchmaker fires `matchmakerMatched`; server must create (or allow) a match so the client can `socket.JoinMatchAsync(matched)` (token-join; relayed match is enough). **Match id = challengeId for matchmade games** (`HandShakeStartState.cs:19-22`).
5. Client `OnRecievedMatchmakerMatched` (`NakamaConnection.cs:666-701`): ignores if ticket != matched.Ticket; joins match; joins room chat `channel = match.Id` (persistence=true, hidden=false); calls `FinalizeMatchmaking(match, matched.Users)`; clears ticket; leaves match.
6. `FinalizeMatchmaking` (`NakamaInstance.cs:792-880`): picks a random common scenario from users' `scenarios` property (so each client may pick differently; the server's reply decides), then sends RPC **`MatchmakingRequest`** `{matchShortCode, participantData:{gameInformation, platform,..}, matchData:{expansion}, skill, customQuery, playerIds:[userIds], matchId}` (`MatchmakingRequestHelper.cs`, `NS:1163-1188`). Short codes: `AUTOMATCH_2P|3P|4P|3P_4P|5P|6P|5P_6P`, `FREEMATCH_2P|3P`, `BIG_GAME`. Response `.MatchmakingResponse`; error => back to Idle. If scriptData has `bigGameId` => BigGame (D).
7. Server -> each of `playerIds`: push `ScriptMessage extCode=MatchFoundMessage` shaped like GS `MatchFoundMessage` (`GameSparks.Api.Messages/MatchFoundMessage.cs`): `{matchId, participants:[<PlayerDetails GSData>...], scriptData:{<gameInfo>}}`. Client reads `participants` via `PlayerDetails.CreateListOfPlayerDetailsFromScriptData(BaseData,"participants")` (needs `userId` or `id`, `displayName`, plus `PlayerDetails` fields) and `MultiplayerGameInformation.CreateFromGsData(scriptData)` (`NL:229-234`). Participant order = seat order. Server must dedupe (N clients each call `MatchmakingRequest` for the same `matchId`) and pick one scenario/gameInfo.
8. `MatchWaitState.OnMatchFound`: if `participants[0].id == me` -> **StartHandshake** (creator), else **Handshake** (`MatchWaitState.cs:85-105`).
9. Creator (`HandShakeStartState.cs`): sets victoryPoints from scenario, sorts players, `UpdateStartPlayer`, seeds `seed=Environment.TickCount`, `diceSeed=Guid hash`, `colorSeed=DateTime.Ticks`; sends **`CreateChallengeRequest`** (`NS:987-1012`): `challengeShortCode:"CATAN", autoStartJoinedChallengeOnMaxPlayers:true, minPlayers=maxPlayers=humanCount, usersToChallenge:[other humans], endTime:+2d, scriptData:{challengeInstanceId, seed, colorSeed, diceSeed, gameInfo}`. Response only checked for `HasErrors`. Server must create the session directly in RUNNING (nobody ever calls `AcceptChallengeRequest`, dead).
10. Handshake (`HandShakeWaitState.cs`): listens for push `ChallengeIssuedMessage` (`{challenge:{challengeId}}`, sets ChallengeId; spectator host then calls `GAME_HOST_ACCEPTED`) and **polls `GAME_GET_CURRENT_SESSION` after 5 s and every 5 s**; when `challengeState==RUNNING` and `currentChallengeId` set (and != `wasKickedFromChallengeId`) it jumps to GameSetup with the gameInfo built from that response. **This poll is the only reliable "started" signal**: `ChallengeStartedMessage` is not routed, and `GAME_HOST_CHALLENGE_STARTED` crashes (see C). Timeout 30 s -> `GAME_EXIT_SESSION` + CancelMatch. `COMPLETED` -> exit + cancel.
11. GameSetup: `GAME_GET_GAME_DETAILS_V3(challengeId)` (30 s watchdog) -> seeds, players, hostIdx, lastPlayed map -> scene load (`GameSetupState.cs`).
12. WaitForGameLogic: every 3 s up to 20 s sends `GAME_PLAYER_SETUP_READY` (spectator: `GAME_HOST_SETUP_READY`). Server: when all humans are ready push `GAME_START_GAMELOGIC` to all (`GameLogicWaitState.cs`). Server should also push `GAME_SCENE_LOADED{playerId}` to others when a player becomes ready (loading-screen portraits, `CatanLoadingVersusScreenController.cs:179`).
13. Loading screen finished -> state Game -> `GAME_PLAYER_HAS_STARTED_GAMELOGIC`; **response scriptData.playersStartedIds must contain my userId or it is treated as error** (`NS:1071-1086`). In-game scene load -> `GAME_PLAYER_IN_GAME` (`GameHub.States/BaseLoadIngameState.cs:32`); leaving to menu -> `GAME_PLAYER_NOT_IN_GAME`. Ping loop starts.
14. Cancel (`CancelMatchState.cs`): RPC `MatchmakingRequest{action:"cancel", matchShortCode}` (MATCH_CANCEL is dead) then `socket.RemoveMatchmakerAsync(ticket)` (client tolerates "Matchmaker ticket not found"). Aborted waits also send `GAME_EXIT_SESSION{REASON}`.
15. `MATCH_HANDSHAKE_FAILED`, `MatchNotFoundMessage`, `MatchUpdatedMessage` are never delivered (not routed): dead.

### B2. Custom match lobby (`Common.Net/Lobby.cs`, `GameHub.States/BaseCustomMatchState.cs`)
Lobby id doubles as challenge id (`MultiplayerGameInformation.UpdateFromGSData` falls back `ChallengeId = lobbyId`, `MultiplayerGameInformation.cs:~748`; creator sends it back as `challengeInstanceId`).
1. Owner: `LOBBY_CREATE{GAME_INFO}` -> resp LobbyUpdate (C/E). Missing `lobbyId` => failure.
2. Owner: `LOBBY_INVITE{LOBBY_ID,PLAYER_ID}` -> server pushes `LOBBY_INVITE` to invitee and `LOBBY_UPDATE_PLAYERS` to lobby. Invitee: `LOBBY_ACCEPT{LOBBY_ID}` (resp LobbyUpdate; server pushes `LOBBY_UPDATE_PLAYERS` to others) or `LOBBY_DECLINE`.
3. Anyone: `LOBBY_PLAYER_IS_READY{IS_READY}` -> `LOBBY_UPDATE_PLAYERS` (readyPlayerIds). Owner: `LOBBY_UPDATE_GAME_INFO{GAME_INFO,REMOVE_PLAYER_ID}` -> `LOBBY_UPDATE_GAMEINFO` push. Owner: `LOBBY_KICK` -> target gets `LOBBY_GOT_KICKED`. `LOBBY_LEAVE`. Rejoin after a match: `LOBBY_GET_GAMEINFO` (`Lobby.ReenterLobbyAfterMatch`).
4. Start (owner, needs all ready, >1 human): `LOBBY_START_GAME{LOBBY_ID,GAME_INFO:{gameInfo}}` -> resp `canStart:true` + gameInfo keys (client does `gameInfo.UpdateFromGSData(scriptData)`). Server pushes `LOBBY_START_GAME` (data = gameInfo keys, must contain `lobbyId` or `challengeId`) to the other human lobby members.
5. Owner then runs `CreateChallenge` = same as B1 step 9 (`MatchConnectController.CreateChallenge`, `BaseCustomMatchState.cs:612-629`); non-owners on `LOBBY_START_GAME` go to `WaitForHandshake` = B1 step 10. Remaining as B1 11-14.
6. Spectator host (gameInfo `spectatorId`, custom match only): spectator is not a seat. It calls `GAME_HOST_ACCEPTED` on ChallengeIssued, `GAME_HOST_SETUP_READY` instead of PLAYER_SETUP_READY (`HandShakeWaitState.cs:105`, `GameLogicWaitState.cs:57-66`). Server should treat it as a participant for ready/start purposes (inferred).
7. Leaving lobby mid-way: `LOBBY_LEAVE`; `Authentication.OnBeforeLogout` also leaves.

### B3. Playing
- **Action**: client builds blob, `GAME_ACTION_V3{challengeInstanceId, GAME_ACTION_STATE, ACTION_OWNER_INDEX, ACTION_ID, CONTEXTS:{contexts:[{playerIdx,turntimer,contextSwitchId,contextId,nextUniqueId,previousContextId,lastPlayedUniqueId,lastPlayedActionIdContext}]}, TURNTIMER_RAN_OUT_PLAYER_ID ("-" none), TURNTIMER_INFO:{playerIdx,timer}}`. Server validates ACTION_ID, appends to `gameActions`, updates counters/context, replies `{lastPlayedActionId|uniqueActionId}`, pushes `GAME_ACTION_PLAYED` to others. Client then applies the action locally (`TaskActionPlayed.OnSuccess`).
- **AI actions** (AI seats, host only): sent under `ACTION_OWNER_INDEX` of the AI seat by the host client. Non-host drops them.
- **Turn timer expiry**: `GAME_ACTION_TURNTIMER` (same fields minus nothing; `TURNTIMER_RAN_OUT_PLAYER_ID` = userId of the timed-out player). Server pushes `GAME_ACTION_TURNTIMER_PLAYED`. Server counts timed-out turns for AFK kick (3x, `KickReason.AFK_3X_TURNTIMER`).
- **Dedup**: client dedups received actions by `(ActionPlayedByPlayerIdx, UniqueId)` (`TaskActionReceived.cs`); duplicates are harmless.
- **Trade (real-time)**: `GAME_TRADE{challengeInstanceId, PLAYER_IDS:{playerIds:[..]}, TRADE:{..RTTModel json..}, TRADE_TYPE:"<full type name>", TURNTIMER_INFO}` -> server pushes `GAME_TRADE` to each id in `playerIds` (client already excludes self via active network ids). Not persisted.
- **Ping** every 25 s `GAME_PING_V3{TIMERS:{timers:[{index,timer}]}}` -> resp `{allLastPlayedActionsPerPlayer:[{playerIndex,lastPlayed}], hostIdx}`. Missing keys => 0/empty => client may spuriously Reconnect.
- **Turn timer multicast**: host sends `GAME_MULTICAST_TURNTIMERS{TIMERS:{timers:[{index,timer}]}}` after a host switch (and `TurnTimer`), server pushes `GAME_MULTICAST_TURNTIMERS` to the others (`TaskMulticastTurntimers.cs`, `Multiplayer.cs:OnTurnTimersMulticasted`).
- **Defaults**: `GAME_GET_TURNTIMERS` (at startup, `TurnTimerValues.cs:62`).
- **Mute**: `GAME_SET_PLAYER_MUTED`/`GAME_GET_MUTED_PLAYERS` (server stores `(challenge, muter)->set`; no push). Whether server filters chat/emoji for muted is unknown (client may filter locally, `MutePlayersController.cs`).
- **Emoji**: `CHAT_EMOJI{PLAYER_IDS:{playerIds}, EMOJI_ID}` -> push `CHAT_EMOJI{emojiId, who}` (who = sender displayName) to those ids.
- **Game chat**: Nakama room channel `JoinChatAsync(challengeId, Room, persistence=true, hidden=false)`; message content = JSON string `{"message":"<text>"}`; sender = Nakama userId (`NakamaConnection.cs:777-880`, `Common.Screens.Chat/ChatMessage.cs`). On (re)join client lists last 30 messages. Channel id must equal challengeId (matchId for matchmade, lobbyId for custom).
- **Pause / kick / AFK**: `GAME_PLAYER_LEFT{FORCED_QUIT:"True"|"False"}` (app backgrounded/menu: False; explicit quit: True) and `GAME_PLAYER_RETURNED` -> server pushes `GAME_PAUSED{playerId,isPaused,playerData[kickTimers],hostIdx?,challengeId}` to others. Missing pings (35 s) behave like LEFT; `ACCOUNT_PLAYER_DISCONNECTED/CONNECTED` flip online flag in UI. `GAME_GET_KICKTIMERS` polls current kick timers (ConnectionLostHandler). Kick timer expiry -> `GAME_PLAYER_WAS_KICKED{playerId,hostIdx?}` to all + kicked player gets next `GAME_GET_CURRENT_SESSION` with `wasKickedFromChallengeId/wasKickedReason`. 3x turn timeout -> `GAME_PLAYER_AFK_KICKED` to that player. `GAME_STILL_IN_GAME` (app-focus check / kick-timer UI) -> `{isInGame}`; false => client exits the game. `GAME_EXIT_SESSION{REASON}` = leave current session without result (matchmaking aborts, `IngameUtils.ExitGame`).
- **Votes**: `GAME_VOTE_FOR_CONTINUE` has no caller; `GAME_PLAYER_VOTED` push is dead.
- **Context switches / sync stats**: contexts ride inside `GAME_ACTION_V3`; `GAME_SYNC_STATISTICS{CONTEXT_NAME,REASON}` is fire-and-forget telemetry (REASON: Reconnect|AppRestart|PollingFallback).

### B4. Leave / return / reconnect
1. App focus / network loss: `TaskPlayerLeft` -> `GAME_PLAYER_LEFT(False)`; explicit quit `TaskPlayerExit` -> `GAME_PLAYER_LEFT(True)` + `GAME_EXIT_SESSION`.
2. Back online: `TaskReconnect`: `MatchConnecting.Reconnect` -> `ReconnectState`: `GAME_GET_GAMESTATE_AND_ACTIONS_V3` -> replay actions with `UniqueId > lastPlayedUniqueId` into running GameLogic -> `GAME_SYNC_STATISTICS(Reconnect)` -> `GAME_PLAYER_RETURNED`. If context did not converge in 7 s -> FindRunningSession (`ReconnectState.cs:57-125`).
3. Cold start / crash: main menu runs `FindRunningSessionState`: `GAME_GET_CURRENT_SESSION{REMOVE_WAS_KICKED_FLAG:1 in main menu, currentChallengeId?}` -> if `currentChallengeId` and state != COMPLETED -> `GAME_GET_GAME_DETAILS_V3` -> UI "rejoin?" -> `RejoinState`: `GAME_GET_GAMESTATE_AND_ACTIONS_V3` + rejoin chat channel -> scene load -> `TaskRejoin` replays `gameActions` -> `GAME_PLAYER_RETURNED` (`FindRunningSessionState.cs`, `RejoinState.cs`, `TaskRejoin.cs`). If the client was kicked: response carries `wasKickedFromChallengeId` (== currentChallengeId) and `wasKickedReason` -> kicked dialog; cleared by `REMOVE_WAS_KICKED_FLAG`.
4. Retry: up to 3 current-session tries (`FindRunningSessionState.cs:92`), ping drives Reconnect/Reload on mismatch.

### B5. Finish
1. Final action arrives (win condition inside `AsWinLosePlayers`); every client computes win locally. The designated client calls `GAME_WON` (LE, via action queue after pending actions, `NakamaActionQueue.SendAfterQueueFinished`). Single-player path also calls GAME_WON with `SINGLEPLAYER=1`, `CHALLENGE_ID=""` -> server must ack and do nothing multiplayer-specific.
2. Server: validate challenge, compute ELO (season/tournament variants), XP, karma, update leaderboards/stats; close challenge (state COMPLETED); push `GAME_MULTIPLAYER_RESULT` to all human participants (data in C). Local client sets `IsChallengeClosed=true` itself on sending.
3. `GAME_WON_BY_SERVER` (data: challengeId + same stats as result) for server-forced ends; client then drives its own win screen (`BaseIngameState.GameWonByServer`).
4. After the result the client fetches brackets (`LEADERBOARD_*` brackets in leaderboard doc) and may re-enter the lobby (`LOBBY_GET_GAMEINFO`).
5. `LEADERBOARD_GAME_WON/LOST` and `GAME_SINGLE_PLAYER_GAME_STARTED/FINISHED` have no callers: dead.

### B6. Confirmed with two real clients (2026-10-20, `tools/mp-smoke.sh`, game AI plays both seats)
Runs: quick match (2P base game, 3 full games ~250 actions each, 0 errors), quick match + kill/relaunch of one client mid-game, custom lobby (host invites guest). Both clients got `GAME_MULTIPLAYER_RESULT` every time.
- **Matchmaker** (B1.2): real query `+properties.matchType:QUICK_MATCH +properties.expansions:/.*CatanBaseGame.*/ +properties.scenarios:/.*firstisland.*/ +properties.skill:>=900 +properties.skill:<=1100 properties.karma:>=2 properties.karma:<=4 +properties.appVersion:94 -properties.seasonId:/.*.+.*/`, numeric props `{appVersion:94, karma:3, skill:1000}`; plain relayed Nakama matchmaking works (no hook). An empty `scenarios` property never matches the `/.*.*/` regex term (only happens if the client has no free-match scenario).
- `matchShortCode` is `FREEMATCH_3P` even for a 2-player quick match: never derive player counts from the short code (use matchmaker min/max / gameInfo).
- **Match id = relayed match id with trailing dot** (`<uuid>.`), used verbatim as challengeId, `CHALLENGE_ID`, chat channel. Lobby games: challengeId = lobbyId (client sends it as `CreateChallengeRequest.scriptData.challengeInstanceId` and as `GAME_GET_CURRENT_SESSION.currentChallengeId` hint).
- MatchFound fields top-level (`matchId, participants, scriptData`) work; the second caller gets the push twice (first-call fan-out + re-push to caller), harmless. `participants[0]` creates the challenge.
- Setup sequence seen: `CreateChallengeRequest` -> poll `GAME_GET_CURRENT_SESSION` (RUNNING) -> `GAME_GET_GAME_DETAILS_V3` -> `GAME_PLAYER_SETUP_READY` -> push `GAME_START_GAMELOGIC` (+`GAME_SCENE_LOADED`) -> `GAME_PLAYER_IN_GAME` -> `GAME_PLAYER_HAS_STARTED_GAMELOGIC` -> `GAME_STILL_IN_GAME` -> actions. `hostIdx` 0.
- **ACTION_ID** (F.1, resolved): `ACTION_ID` = global `NetworkSyncId`, per seat strictly non-decreasing with gaps, **equal values occur** (two actions of one context, e.g. `0:38 0:38`). Rule "111 only if lower than the seat's last accepted id" is correct (no 111 in any run). Response `{lastPlayedActionId:<ACTION_ID>}`.
- `GAME_MULTICAST_TURNTIMERS` is sent by **every** client after its own actions (not only by the host after a host switch); relay to the others.
- `GAME_TRADE` (AI trade offers) relayed fine. AI players never let the turn timer run out (no `GAME_ACTION_TURNTIMER` seen; timer/AFK paths still unverified in-game).
- **Reconnect** (B4.3) on cold restart is automatic (no dialog): `GAME_GET_CURRENT_SESSION{REMOVE_WAS_KICKED_FLAG:1,currentChallengeId:""}` -> `GAME_GET_GAME_DETAILS_V3` -> `GAME_GET_GAMESTATE_AND_ACTIONS_V3` -> `GAME_PLAYER_IN_GAME` -> `GAME_GET_MUTED_PLAYERS` -> `GAME_PLAYER_HAS_STARTED_GAMELOGIC` -> `GAME_PLAYER_RETURNED`, then normal play. Down ~40 s < ping timeout: no `GAME_PAUSED` was needed.
- **Finish**: exactly one client (the winner) sends `GAME_WON{CHALLENGE_ID, EXPANSION, MAP, ITS_THE_FINAL_GAMESTATE, WIN_LOSE,...}`; result push accepted by both.
- **Persisted pushes are re-delivered at every login**: the client deletes only notifications it *listed* at login, never ones it got live. So a push persisted for an online user shows up again later (an old `GAME_MULTIPLAYER_RESULT` at the next start). Server now persists the result only for offline participants.
- **Durable requests** (`SetDurable(true)`: `MatchmakingRequest`, `SEASON_GET_SEASONS_DETAILS`, `ChangeUserDetailsRequest`, ...) are persisted per user in `<persistentDataPath>/gs_default_<userId>.dat` and replayed after a restart -> handlers must be idempotent; a replayed `MatchmakingRequest` for a match older than 2 min is ignored (no MatchFound push).
- **Client bugs worked around in the mod** (`Communitan/Harness.cs`; needed for any custom server):
  - Pushes arrive on the socket thread (`client.NewSocket()` without main-thread dispatch). `NakamaInstance.ProcessMessage` -> `NakamaCallbackInvoker.Instance()` creates its GameObject lazily, which throws off the main thread -> **every push is silently dropped** unless the invoker was created on the main thread before (e.g. by a stored notification at login) and it is not `DontDestroyOnLoad` either. The mod keeps one alive from the main thread.
  - `NakamaInstance.SetUserId` restores `durableQueuePaused` from a value captured before an async main-thread callback: two logins in quick succession leave the durable queue paused forever (all durable requests hang). The mod unpauses it 5 s after login.

---------------------------------------------------------------------
## C. Per-id entries

Common: `challengeInstanceId` string on every LCE request. `src` NS lines are where the request is built.

### C.1 Matchmaking / challenge (non-event requests)

### MatchmakingRequest
kind: Request (RPC id `MatchmakingRequest`) · req: `{matchShortCode:str, participantData:{gameInformation:{gameInfo keys}, platform, [karma,friends,guildMembers..]}, matchData:{expansion}, skill:long, customQuery:{$and:[..]}, playerIds:[userId], matchId:str, action?:"cancel"}` · resp: `.MatchmakingResponse`; scriptData optional `{bigGameId,startDateTime,timeLeftInMs}` for Big Game · push: `MatchFoundMessage` to each playerId · src: `Common.Net/NakamaSender.cs:1163-1226`, `Common.Net/MatchmakingRequestHelper.cs:10-90` · notes: called once per client after Nakama matched (B1.6); `customQuery` can be ignored; cancel carries only `matchShortCode,action`.

### CreateChallengeRequest
kind: Request · req: `{challengeShortCode:"CATAN", autoStartJoinedChallengeOnMaxPlayers:true, endTime, minPlayers, maxPlayers, usersToChallenge:[userId], scriptData:{challengeInstanceId, seed, colorSeed, diceSeed, gameInfo:{..}}}` · resp: only `HasErrors` read · push: `ChallengeIssuedMessage` (`{challenge:{challengeId}}`) to usersToChallenge (optional; poll covers); do NOT send `ChallengeStarted*`/`GAME_HOST_CHALLENGE_STARTED` · src: `NS:987-1012`, `HandShakeStartState.cs:62` · notes: creator is `participants[0]` / lobby owner; `challengeInstanceId` is the session key (matchId or lobbyId); seeds: ours keeps them (`CATAN_SERVER_RNG=off`) or replaces them with CSPRNG values (`seeds`), durable retry detected by the client seeds; session must be RUNNING immediately; store seeds + gameInfo.

### AcceptChallengeRequest
dead (`NS:1041`, no caller). `OnChallengeJoined`/`ChallengeAcceptedMessage` pushes optional (only update a UI dot; `NL:339-357`).

### MATCH_REGISTER_FOR_QUICKMATCH / MATCH_REGISTER_FOR_AUTOMATCH / MATCH_CANCEL
kind: LCE · req: `{GAMEINFO:GSData}` · dead (no caller; replaced by Nakama matchmaker + `MatchmakingRequest`).

### MATCH_HANDSHAKE_FAILED (push)
dead (no listener/route).

### C.2 LOBBY_* (all LE)

### LOBBY_CREATE
req: `{GAME_INFO: gameInfo GSData}` · resp: LobbyUpdate (below) · push: none · src: `NS:1250` · notes: caller becomes `ownerId`; assign `lobbyId`.
LobbyUpdate resp/push shape (`Common.Net/LobbyUpdate.cs:19-45`): `{lobbyId, ownerId, lobbyPlayers:[PlayerDetails], invitedPlayers:[PlayerDetails], readyPlayerIds:[userId], aiPlayerIds:[id], + gameInfo keys flat (E) incl. sortedPlayerIds}`. `lobbyPlayers` is expected to include invited players too (client subtracts `invitedPlayers`). Owner is always treated ready.

### LOBBY_GET_GAMEINFO
req: `{LOBBY_ID}` · resp: LobbyUpdate · src: `NS:1230`.

### LOBBY_INVITE
req: `{LOBBY_ID, PLAYER_ID}` · resp: ack (error codes read: any; likely PlayerOffline 22 / PlayerIsIngame 23) · push: `LOBBY_INVITE` -> invitee; `LOBBY_UPDATE_PLAYERS` -> lobby · src: `NS:1270`.

### LOBBY_KICK
req: `{LOBBY_ID, PLAYER_ID}` · resp: ack · push: `LOBBY_GOT_KICKED` -> target; `LOBBY_UPDATE_PLAYERS` -> rest · src: `NS:1290`.

### LOBBY_LEAVE
req: `{LOBBY_ID}` · resp: ack · push: `LOBBY_UPDATE_PLAYERS` · src: `NS:1310` · notes: owner-leave behaviour unknown (see F).

### LOBBY_ACCEPT
req: `{LOBBY_ID}` · resp: LobbyUpdate (error => stays out) · push: `LOBBY_UPDATE_PLAYERS` -> others · src: `NS:1321`.

### LOBBY_DECLINE
req: `{LOBBY_ID}` · resp: ack · push: `LOBBY_UPDATE_PLAYERS` · src: `NS:1341`.

### LOBBY_PLAYER_IS_READY
req: `{LOBBY_ID, IS_READY:0|1}` · resp: ack · push: `LOBBY_UPDATE_PLAYERS` · src: `NS:1356`.

### LOBBY_UPDATE_GAME_INFO
req: `{LOBBY_ID, GAME_INFO:gameInfo, REMOVE_PLAYER_ID:"-"|userId}` · resp: ack · push: `LOBBY_UPDATE_GAMEINFO` (LobbyUpdate) -> others · src: `NS:1407`, `Lobby.cs:UpdateGameInfo` · notes: `sortedPlayerIds` in GAME_INFO = authoritative seat order incl. AI ids.

### LOBBY_START_GAME
req: `{LOBBY_ID, GAME_INFO:{gameInfo:{..}}}` (note extra nesting) · resp: `{canStart:bool, + gameInfo keys}` · push: `LOBBY_START_GAME` -> other humans · src: `NS:1367` · notes: server may reject (canStart=false) if not everyone ready.

### LOBBY_START_BIG_GAME
same shape as LOBBY_START_GAME · src: `NS:1387` (D).

### LOBBY_UPDATE_PLAYERS / LOBBY_UPDATE_GAMEINFO (push)
`data` = LobbyUpdate shape · src: `NL:320-336`, `LobbyUpdate.cs`.

### LOBBY_INVITE (push)
`data` = gameInfo keys + `lobbyId:str` + `player:{PlayerDetails of inviter}` (client requires `lobbyId` key) · src: `NL:308-318`.

### LOBBY_START_GAME (push)
`data` = gameInfo keys (`UpdateFromGSData(message.Data)`); include `lobbyId`/`challengeId` and `sortedPlayerIds` · src: `NL:296-301`.

### LOBBY_GOT_KICKED (push)
`data` = {} · src: `NL:303`.

### C.3 GAME_* requests

### GAME_GET_CURRENT_SESSION
kind: LE · req: `{REMOVE_WAS_KICKED_FLAG:0|1, currentChallengeId?:str}` · resp scriptData: `{currentChallengeId:str|absent, challengeState:"ISSUED"|"RUNNING"|"WAITING"|"COMPLETED"|"COMPLETE", wasKickedFromChallengeId?, wasKickedReason?:"AFK_3X_TURNTIMER"|"KICKTIMER"|"UNKNOWN", playerDetails:[..], + gameInfo keys (E)}`; Big Game alt: `{currentBigGameSessionId, currentBigGameSession, currentBigGameGameInfo}`; none => empty scriptData · push: none · src: `NS:929-985`, `KickedFromChallenge.cs` · notes: also the handshake poll (B1.10). Returns the player's latest non-closed session. `currentChallengeId` in request = local hint (matchId or lobbyId). gameInfo is built only if `playerDetails` non-empty.

### GAME_GET_GAME_DETAILS_V3
kind: LE · req: `{CHALLENGE_ID}` · resp scriptData: `{seed, colorSeed, diceSeed, hostIdx, playerDetails:[PlayerDetails in seat order], allLastPlayedActionsPerPlayer:[{playerIndex,lastPlayed}], kickedPlayerDetails:[..], reportedPlayers:[userId], + gameInfo keys}` · src: `NS:1111-1142` · notes: failure if own id is in `kickedPlayerDetails`. Also used by FindRunningSession and GameSetup. `diceSeed` default -1 if absent (client then uses old behaviour), hostIdx default -1.

### GAME_GET_GAME_DETAILS / GAME_GET_GAMESTATE_AND_ACTIONS_V2 / GAME_GET_CURRENT_CHALLENGE_ID / GAME_POLL_SYNC / GAME_PING / GAME_ACTION_V2 / GAME_SYSAUTO_ACTION_V2 / GAME_SWITCH_GAME_CONTEXT / _V2 / GAME_SWITCH_MULTIPLE_CONTEXTS / GAME_SWITCH_CONTEXT_WITH_UNIQUEID / GAME_CHANGE_HOSTIDX / GAME_TURNTIMER_RAN_OUT / GAME_OTHER_PLAYER_NOT_PINGABLE / GAME_OTHER_PLAYER_PINGABLE_AGAIN
dead: request classes exist, no caller. Do not implement (stub OK).

### GAME_SET_GAMESTATE
kind: LE · req: `{CHALLENGE_ID, GAMESTATE, GAMEINFO, SEED, COLOR_SEED, DICE_SEED}` · src: `NS:1147` · dead in practice (`SendSetGameState` has no caller; seeds travel in CreateChallenge).

### GAME_HOST_ACCEPTED
kind: LE · req: `{CHALLENGE_ID}` · resp: ack · src: `NS:1029` · notes: spectator host only (B2.6).

### GAME_HOST_SETUP_READY
kind: LE · req: `{CHALLENGE_ID}` · resp: ack · src: `NS:1058` · notes: spectator host's SETUP_READY.

### GAME_PLAYER_SETUP_READY
kind: LCE · req: `{challengeInstanceId, GAMESTATE:""}` · resp: ack · push: `GAME_SCENE_LOADED` (others), `GAME_START_GAMELOGIC` when all ready · src: `NS:1091` · notes: resent every 3 s until GAME_START_GAMELOGIC arrives -> must be idempotent; also after a rejoin.

### GAME_PLAYER_HAS_STARTED_GAMELOGIC
kind: LCE · req: `{challengeInstanceId}` · resp scriptData: `{playersStartedIds:[userId]}` MUST include requester · src: `NS:1074`.

### GAME_PLAYER_IN_GAME / GAME_PLAYER_NOT_IN_GAME
kind: LE · req: `{}` (session inferred from user) · resp: ack · src: `NS:2535,2548` · notes: presence flags (in game scene vs menu); drives `isInGame` of STILL_IN_GAME; no push required (client reacts to `GAME_PAUSED`).

### GAME_ACTION_V3
kind: LCE · req: `{challengeInstanceId, GAME_ACTION_STATE:b64, ACTION_OWNER_INDEX:int, ACTION_ID:int, CONTEXTS:{contexts:[..]}, TURNTIMER_RAN_OUT_PLAYER_ID:str|"-", TURNTIMER_INFO?:{playerIdx,timer}}` · resp scriptData: `{lastPlayedActionId:int}` (or `uniqueActionId`); errors: IncorrectLastAction 111, ChallengeClosed 24, PlayerWasKickedFromChallenge 46, UnableToUpdateMultiplayerProgress 110 · push: `GAME_ACTION_PLAYED` -> other humans · src: `NS:2938`, `NakamaActionQueue.cs`, `TaskActionPlayed.cs` · notes: B3. Ours with `CATAN_SERVER_RNG=full` (docs/design/server-rng.md): req needs `communitanCaps`; resp + push carry `ccsRng:{u,w,d?}` (uid, 64-bit word hex, server dice); roll/alchemist blobs are rewritten; same uid with another payload = 111.

### GAME_ACTION_TURNTIMER
kind: LCE · req: same as V3 (fields `GAME_ACTION_STATE, ACTION_OWNER_INDEX, ACTION_ID, CONTEXTS, TURNTIMER_RAN_OUT_PLAYER_ID, TURNTIMER_INFO`) · resp: same · push: `GAME_ACTION_TURNTIMER_PLAYED` · src: `NS:2895` · notes: several clients may send the same expiry (host + player); first valid wins, later ones should return IncorrectLastAction or an idempotent success (client handles both: 111 => rejected/reconnect).

### GAME_TRADE
kind: LCE · req/push: B3 · resp: `HasErrors` only · src: `NS:3037`.

### GAME_MULTICAST_TURNTIMERS
kind: LCE · req: `{challengeInstanceId, TIMERS:{timers:[{index:int,timer:float}]}}` · resp: ack · push: `GAME_MULTICAST_TURNTIMERS` -> other humans · src: `NS:221`.

### GAME_PING_V3
kind: LCE · req: `{challengeInstanceId, TIMERS:{timers:[..]}}` · resp scriptData: `{allLastPlayedActionsPerPlayer:[{playerIndex,lastPlayed}], hostIdx}` · src: `NS:2754` · notes: also the liveness heartbeat (35 s).

### GAME_GET_GAMESTATE_AND_ACTIONS_V3
kind: LE · req: `{CHALLENGE_ID}` · resp scriptData: `{gameActions:[b64 action,...ordered], playerDetails:[..], kickedPlayerDetails:[..], contextSwitchId, lastPlayedUniqueId, nextUniqueId, contextId, previousContextId, lastPlayedActionIdContext, seed, colorSeed, diceSeed, allLastPlayedActionsPerPlayer:[..], hostIdx}` · src: `NS:2641-2683` · notes: this is the replay source (A.11). Client treats a request error as fatal for reconnect (`onError`). Ours (full): `ccsRngMode:"full"`, `ccsRngGen`, `ccsRng:[{u,w,d?}]` parallel to `gameActions` (details: mode + gen only).

### GAME_PLAYER_LEFT
kind: LCE · req: `{challengeInstanceId, FORCED_QUIT:"True"|"False"}` · resp: ack (error code returned to client) · push: `GAME_PAUSED{isPaused:true}`; with FORCED_QUIT=True also start kick/replace-with-AI flow (`GAME_PLAYER_WAS_KICKED`) · src: `NS:2717`.

### GAME_PLAYER_RETURNED
kind: LCE · req: `{challengeInstanceId}` · resp: ack; errors 24/46 surfaced · push: `GAME_PAUSED{isPaused:false}` · src: `NS:2699`.

### GAME_EXIT_SESSION
kind: LE · req: `{REASON:str}` · resp: ack · src: `NS:2735` · notes: leave the user's current session (also pre-start). Treat as quit: other players see pause/kick.

### GAME_STILL_IN_GAME
kind: LE · req: `{CHALLENGE_ID}` · resp scriptData: `{isInGame:bool}` (TimeOut error also counts as in-game) · src: `NS:2479`.

### GAME_GET_KICKTIMERS
kind: LE · req: `{CHALLENGE_ID}` · resp scriptData: `{playerData:[{playerId,isKickTimerRunning,playerTimer:float}]}` · src: `NS:2622`, `PlayerKickTimerData.cs`.

### GAME_GET_TURNTIMERS
kind: LE · req: `{}` · resp scriptData: `{turntimers:{default:{<ExpansionsEnum name>:float}, start:{..}, passive:{..}}}` (seconds, client default 90) · src: `NS:2587-2617`, `TurnTimerValues.cs` · notes: names from `ExpansionsEnum` (CatanBaseGame, CatanSeafarer, CatanCitiesAndKnights, RivalsBaseGame, CatanRiseOfTheInkas, CatanBigGame, ...).

### GAME_SET_PLAYER_MUTED
kind: LCE · req: `{challengeInstanceId, PLAYER_ID, IS_MUTED:0|1}` · resp: ack · src: `NS:2506`.

### GAME_GET_MUTED_PLAYERS
kind: LCE · req: `{challengeInstanceId}` · resp scriptData: `{mutedPlayerIds:[userId]}` · src: `NS:2519`.

### GAME_VOTE_FOR_CONTINUE
kind: LE · req: `{CONTINUE_GAME:0|1}` · src: `NS:2566` · no caller (dead); `GAME_PLAYER_VOTED` push dead.

### GAME_SYNC_STATISTICS
kind: LCE · req: `{challengeInstanceId, CONTEXT_NAME, REASON}` · resp: ignored · src: `NS:2575` · notes: telemetry only.

### GAME_GET_AI_PLAYERDETAILS
kind: LE · req: `{INCLUDE_BIG_GAME_PLACEHOLDERS:1}` · resp scriptData: `{playerDetails:[PlayerDetails of AI players (isAi, difficulty, name..)]}` · src: `NS:2821`, `PlayerCollection.cs:116` · notes: cached on disk by `aiPlayerVersion`; AI ids appear in `sortedPlayerIds`/`aiPlayerIds`. Entry = flat PlayerDetails with `userId`=`AIPlayerNames` enum name (client stores by `Id==enum name`; 30 entries: 10 names x {"",_easy,_hard}), `displayName`=base name, `isAi:true`, `difficulty` AIDifficulty int (0 Easy,1 Normal,2 Hard), `hidden`. Account `aiPlayerVersion:1` makes the client use `StreamingAssets/aiPlayerVersion1.txt` + local `<Name>.txt` instead of calling this.

### GAME_WON
kind: LE · req: `{CHALLENGE_ID ("" for single player), WON:0|1, EXPANSION:<ExpansionsEnum name; CatanExplorers sent as CatanCitiesAndKnights>, MAP:<scenario name>, SINGLEPLAYER:0|1, WIN_LOSE:{win_lose:[{playerName,playerId,playerComId,rank,vp,color,victorypoints,roadsBuilt,settlementsBuild,citiesBuild,devCardsVP,islandPoints,armySize,...}], playTime:"dd:hh:mm:ss"}, ITS_THE_FINAL_GAMESTATE:b64 state}` · resp: `HasErrors` only · push: `GAME_MULTIPLAYER_RESULT` -> all participants · src: `NS:2992-3005`, `Common.Net.PlayerStatistics/StatisticsUtils.cs:GetWinLoseStatsForCatan`, `Common.IngameMenu/WinGameVictoryStateCatan.cs:66`, `WinGameDefeatStateCatanBase.cs:59` · notes: sender = first human winner (WON=1) or, if no human winner, first human loser (WON=0). Rank is by victorypoints. Server must be idempotent (Rivals/Big Game variants also send it).

### GAME_SINGLE_PLAYER_GAME_STARTED / _FINISHED, LEADERBOARD_GAME_WON / LEADERBOARD_GAME_LOST
dead (no callers).

### GAME_CUSTOM_MATCH_REAL_TIME_CREATED, GAME_PLAYER_VOTED, GAME_TRADE_PREFS_CHANGED, GAME_STATE_REQUESTED, GAME_UNIQUE_IDS_UPDATE (pushes)
dead / dangerous: no `NL` listener (STATE_REQUESTED has a null-safe invoker; UNIQUE_IDS_UPDATE calls `Listener(...)` unguarded in `NakamaCallbackInvoker.cs:131-133` with no subscriber -> NullReferenceException). Never send GAME_UNIQUE_IDS_UPDATE.

### C.4 GAME_* pushes (ScriptMessage extCode; fields in `data`)

### GAME_ACTION_PLAYED
data: `{gameActionState:b64, actionOwnerId:int, lastPlayedActionId:int (or uniqueActionId), playerId:userId (sender), challengeId?, turntimer_playerIdx?:int, turntimer_timer?:float}` · src: `NL:649-682`, `TryUpdateActionId NL:~727` · notes: client decodes `gameActionState` to get `ActionPlayedByPlayerIdx`/`UniqueId`; skips if own. `lastPlayedActionId` updates the local per-seat counter (`MatchConnectDetails.UpdatePlayedActionIdsAfterReceive`) -> it must equal the value stored for seat `actionOwnerId`. Not filtered by challengeId on the client; send only to participants.

### GAME_ACTION_TURNTIMER_PLAYED
data: same as GAME_ACTION_PLAYED · src: `NL:700-751`.

### GAME_TRADE (push)
data: `{playerIds:[userId], trade:{..}, tradeType:str, turntimer_playerIdx?, turntimer_timer?}` · src: `NL:929-946`. `tradeType` is resolved with `Type.GetType` - echo exactly what the sender sent.

### GAME_MULTICAST_TURNTIMERS (push)
data: `{timers:[{index,timer}]}` · src: `NL:287-294`.

### GAME_START_GAMELOGIC
data: `{challengeId}` · src: `NL:754-765` · notes: one-shot; ignored if challengeId != current.

### GAME_SCENE_LOADED
data: `{playerId, challengeId}` · src: `NL:623-631`.

### GAME_PAUSED
data: `{challengeId, playerId, isPaused:bool, playerData:[{playerId,isKickTimerRunning,playerTimer}], hostIdx?:int}` · src: `NL:767-799` · notes: `isPaused=true` -> player left; false -> returned; `hostIdx` triggers `TaskSwitchHost`.

### GAME_PLAYER_WAS_KICKED
data: `{challengeId, playerId, hostIdx?}` · src: `NL:633-646` · notes: seat becomes AI (`TemporaryAI`), `PlayerCollection.KickedPlayerIds()` comes from `kickedPlayerDetails` of the state responses; send to all remaining humans AND the kicked player.

### GAME_PLAYER_AFK_KICKED
data: `{challengeId}` · to the kicked player only · src: `NL:609-620`, `Common.Net/KickedBecauseAfkHandler.cs`.

### GAME_MULTIPLAYER_RESULT
data (ServerStatistics, `Common.Net.PlayerStatistics/ServerStatistics.cs:110-243`): `{win_lose:[{playerId, rank, xpEarned|defaultXP, eloBefore, increaseElo, placementMatchesPlayed, karma, [isSeasonParticipant, seasonEloBefore, increaseSeasonElo, seasonRank, seasonPlacementMatches], [tournamentId, tournamentEloBefore, increaseTournamentElo, tournamentRank, tournamentPlayedGames, tournamentNotEnoughPlacementMatches, tournamentMaxGamesPlayed]}], gameInfo:{isSeason, sortedPlayerIds}, startDate, endDate}` · src: `NL:899-908` · notes: client adds `xpEarned` of local player to its XP; ELO values outside `eloBefore<0`, `|increaseElo|>100` are reset to 1000/0. `startDate/endDate` format per `Utilities.GetDateTime`.

### GAME_WON_BY_SERVER
data: `{challengeId, + same as GAME_MULTIPLAYER_RESULT}` · src: `NL:910-918`.

### GAME_HOST_CHALLENGE_ISSUED / GAME_HOST_CHALLENGE_DRAWN
data: `{challengeId}` · src: `NL:383-436`. ISSUED = alternate to `ChallengeIssuedMessage` (spectator-host flow). DRAWN = challenge closed without result -> `ChallengeClosedEvent` -> all wait states abort / in-game error.

### GAME_HOST_CHALLENGE_STARTED
**Do not send.** Handler invokes `ChallengeStartedEvent(null)`; `HandShakeWaitState.OnChallengeStarted(null)` dereferences `gameInfo.ChallengeId` (`HandShakeWaitState.cs:~113`) -> NRE, handshake stuck. Rely on polling.

### ACCOUNT_PLAYER_CONNECTED / ACCOUNT_PLAYER_DISCONNECTED
data: `{playerId}` (+`hostIdx?` on DISCONNECTED) · src: `NL:855-876`, `PlayerCollection.cs:435-450` · notes: server should emit when a player's presence changes (social online dots) and during a game when a seated player's socket drops/reconnects.

### CHAT_EMOJI (push)
data: `{emojiId:str, who:str (sender displayName)}` · src: `NL:801-815`, `Emoji/EmojiController.cs`.

### Challenge* GS messages (non-script)
| class | routed? | client use |
|---|---|---|
| `ChallengeIssuedMessage` | yes | `{challenge:{challengeId}}` -> ChallengeIssuedEvent (`NL:414`) |
| `OnChallengeJoined` (sic; `ChallengeJoinedMessage` fields `who`) | yes | UI dot, `who` = displayName (`NL:339`) |
| `ChallengeAcceptedMessage` | yes | no subscriber in NL |
| `ChallengeChatMessage` | yes | handled but game chat uses Nakama channels |
| `SessionTerminatedMessage` | yes | `SessionTerminatedEvent` -> logout |
| `ChallengeStarted/Drawn/Lost/Declined/Waiting/Expired/...` | no | dead (class listeners exist in NL but dispatch drops them) |

### C.5 CHAT_* requests (LE)

### CHAT_EMOJI
req: `{PLAYER_IDS:{playerIds:[userId]}, EMOJI_ID:str}` (sender excluded; skipped if list empty) · resp: ignored · push: `CHAT_EMOJI` -> each id · src: `NS:2785`, `Emoji/EmojiController.cs:96-104`.

### CHAT_GET_PLAYER_ID
req: `{PLAYER_NAME}` · resp scriptData: `{playerId, displayName, isOnline}` · src: `NS:3663` · notes: whisper lookup.

### CHAT_SEND_TO_PLAYER_ID
req: `{PLAYER_ID, MESSAGE}` · resp: error check only · push: whisper delivered as `TeamChatMessage` (see social doc) · src: `NS:3710`.

Game chat itself: Nakama channel (B3). `SendChatMessageChallenge` -> `NakamaHandler.SendChatMessage(challengeId, text)` (`NS:2794`).

---------------------------------------------------------------------
## D. BIG_GAME_* (Big Game / event mode; lower priority)

Same envelope. Session model: `Common.Net/BigGameSession.cs`, `BigGameNetworkController.cs`. Pushes `BIG_GAME_ACTION`, `BIG_GAME_WON`, `BIG_GAME_BUILD_FINAL_LEADERBOARD` have listeners in `NL:202-204,600-608,920-927` but are **not in the NakamaInstance dispatch whitelist** -> never delivered to the client in this build (likely broken in official Nakama backend too). `BIG_GAME_BUILD`, `BIG_GAME_WON_BY_SERVER` have no listener at all.

| id | kind | req | resp scriptData | src |
|---|---|---|---|---|
| BIG_GAME_START_SESSION | LE | BIG_GAME_ID, GAME_INFO | ack | NS:1017 |
| BIG_GAME_GET_SESSION_DETAILS | LE | BIG_GAME_ID, GAME_INFO | session (BigGameSession.Create) | NS:1657 |
| BIG_GAME_REGISTRATION | LE | BIG_GAME_ID, RESERVE 1=register / 0=deregister | session/registration info | NS:1678,1714 |
| BIG_GAME_AFTER_RECONNECT | LE | BIG_GAME_ID, TRANSFER_DATA | ack | NS:1699 |
| BIG_GAME_GET_SESSIONS | LE | - | dead (stub body, `NS:1746`) | - |
| BIG_GAME_GET_TURNS | LE | BIG_GAME_ID, START_TURN_NUMBER, TURN_NUMBER_COUNT | `{serverNowTime, turns:[BigGameTurnDetails]}` | NS:1778 |
| BIG_GAME_CONTEXT_UPDATE | LE | BIG_GAME_ID, CONTEXT | gsData | NS:1820 |
| BIG_GAME_ACTION | LE | BIG_GAME_ID, ACTION_ID(str), CONTEXT, TRANSFER_DATA, PLAYER_IDS:{playerIds} | `{syncId}`; on error `existingBuild` | NS:2856 |
| BIG_GAME_TRADE | LE | PLAYER_IDS, TRADE, TRADE_TYPE, TURNTIMER_INFO, BIG_GAME_ID, DELTA | ack | NS:3010 |
| BIG_GAME_SET_VICTORY_POINTS | LE | BIG_GAME_ID, VICTORY_POINTS, VISIBLE_VICTORY_POINTS, ROADS, KNIGHTS, ISLANDS, SETTLEMENTS, CITIES, VP_CARDS, RESOURCE_COUNT, HAS_ENDED | ack | NS:3575 |
| BIG_GAME_WON | LE | BIG_GAME_ID | ack | NS:1735 |
| LOBBY_START_BIG_GAME | LE | see C.2 | `canStart` | NS:1387 |

Pushes (data keys read): BIG_GAME_ACTION (`bigGameId` + `BigGameAction.CreateFromGSData`), BIG_GAME_WON (`bigGameId, winnerId`), BIG_GAME_BUILD_FINAL_LEADERBOARD (`bigGameId` + leaderboard entries). Skip for first milestone.

---------------------------------------------------------------------
## E. Data models

### MultiplayerGameInformation (`Common.Net/MultiplayerGameInformation.cs`, base `Common.GameLogic/GameInformation.cs`)
JSON written by `ToGSData` (`MGI.cs:685-735`, base dict `GameInformation.cs:351-410`) and read by `UpdateFromGSData` (`MGI.cs:736-945`). The reader accepts the data nested at top level, under `scriptData`, or under `gameInfo` (it unwraps `scriptData` then `gameInfo`); also reads `playerDetails`, `challengeId` / `challengeInstanceId` / `lobbyId` at those levels.
Keys: `connectionType, matchType (QUICK_MATCH|AUTO_MATCH|CUSTOM_MATCH|REENTER_MATCH|SINGLEPLAYER), useShuffleMap, diceMode, friendlyRobber, useTurnTimer, turnTime(int s), victoryPoints, randomStartPlayer, expansions[ExpansionsEnum names], scenarios[str], sortedPlayerIds[userId or AI id, seat order], gameMode/themeSet1..3 (Rivals), minPlayers, maxPlayers, startPlayer, rivalsThemeSetWishlist[], turnTimerPlayer, turnTimerOpponent, useKicktimer, creatorId`; auto-match adds `karma, friendsOnly, guildsOnly, isSeason`; tournament `tournamentId, tournamentCustomPresetId`; custom match `aiReplacesPlayers, spectatorId, spectatorSeesUI`; Big Game `session, board, turns, startTime, bigGameCustomMatch*`. `playersCount` (enum string) accepted if min/max absent. Defaults when absent: min 3 / max 4, VP 10, useKicktimer true, aiReplacesPlayers true.
`MatchType` values: `Common.Net/MatchType.cs`. `GameSparksState`: NONE, ISSUED, RUNNING, WAITING, COMPLETED. `KickReason`: UNKNOWN, AFK_3X_TURNTIMER, KICKTIMER.

### PlayerDetails list
`playerDetails` / `participants` / `lobbyPlayers` / `invitedPlayers` / `kickedPlayerDetails` = arrays of PlayerDetails GSData: `userId|id`, `displayName`, `online`, `ingame`, `isAi`, `difficulty`, `karma`, `level`, `elo`, `eloPlacement`, `expansions`, `virtualGoods`, `guildName`, ... (`Common.Net/PlayerDetails.cs:188-300`, account doc). Order is significant; the client replaces its own entry with local details (`PlayerDetails.cs:198-207`).

### Game state / action serialization
- `GAME_ACTION_STATE`, `gameActions[]`, `gameActionState`, `ITS_THE_FINAL_GAMESTATE`, `GAMESTATE`: **base64 of Thrift `TBinaryProtocol`** (`Thrift.Utilities/Serializer.cs:10-60`; `Serializer.CurrentFormat = binary` => base64; `text` => raw UTF8 JSON-ish, unused here). Types: `CommonGameActionState` (`Common.GameLogic.Model/CommonGameActionState.cs`; fields incl. `CommonActionId, PlayerId, UniqueId, NetworkSyncId, ActionPlayedByPlayerIdx, WasActionPlayedByAI, TurntimerRanOutPlayerId, CatanGameActionState`), `CommonGameState`/`GameActionContextState` (`Common.GameLogic.Model/GameActionContextState.cs`: `CurrentContextId, PreviousContextId, ContextSwitchNextUniqueId, NextUniqueId, LastPlayedUniqueId, LastPlayedActionId`). Server may treat all as opaque strings; it only needs the request-level ints (`ACTION_ID`, `ACTION_OWNER_INDEX`, `CONTEXTS`).
- `ContextSwitchData` JSON (`Common.Net/ContextSwitchData.cs`): `playerIdx, turntimer, contextSwitchId, contextId, nextUniqueId, previousContextId, lastPlayedUniqueId, lastPlayedActionIdContext`. `contextId` strings are `CatanGameActionContextId.ToSerializedString()`.
- Trade `TRADE` is plain JSON (`RTTModel.ToJSON`), type name in `TRADE_TYPE`.

### Counters semantics (server must reproduce)
- `lastPlayedActionIdsByGS[seat]` = highest `ACTION_ID` accepted for that seat; returned as `allLastPlayedActionsPerPlayer[{playerIndex,lastPlayed}]` and `lastPlayedActionId` (`MatchConnectDetails.cs:101-119`).
- `contextSwitchId`/`contextIdUniqueId` = latest `CONTEXTS[].contextSwitchId`; `nextUniqueId`/`lastPlayedUniqueId` likewise (last write wins, from the acting client).

---------------------------------------------------------------------
## F. Open questions / risks

1. ~~**ACTION_ID validation rule**~~ RESOLVED in-game (B6): lower-than-last = 111, equal allowed. Original note: inferred (`IncorrectLastAction`): exact comparison (== stored+? vs >=) unknown; need a capture. Client sends `NetworkSyncId` = `ContextSwitchNextUniqueId` at action creation, which may not be monotonically +1 per seat. Safest first implementation: accept any, store max, never return 111 except on duplicate `UniqueId` blob (but a lenient server may hide real desyncs).
2. Who becomes `hostIdx` initially and on host death (lowest-index connected human is assumed). `GAME_GET_GAME_DETAILS_V3` default -1 vs state default 0.
3. Whether the server filters `GAME_ACTION_PLAYED` away from the sender (client tolerates echo). Server filters; works in-game (B6).
4. Exact `GAME_SCENE_LOADED` trigger (assumed: after SETUP_READY) and whether `GAME_START_GAMELOGIC` waits for all humans (assumed). Works in-game with that choice (B6); official timing still unknown.
5. Kick timer durations, ping timeout (client assumes 35 s), AFK threshold (3 timeouts per `KickReason` name), whether LEFT(False) starts a kick timer; `useKicktimer` gameInfo flag semantics.
6. ELO/XP/karma/coin formulas and bracket updates (client only displays; clamps `|increaseElo|<=100`). Season/tournament variants.
7. Matchmaker: server must allow clients to `JoinMatchAsync(matched)`; CONFIRMED default relayed mode works (B6), nothing is sent through the match. Chat channel id (=matchId) must be joinable by the 2-6 matched users only.
8. `MatchmakingRequest` fan-in: N clients call it with the same `matchId`; server must decide when to emit `MatchFoundMessage` (first call vs all) and which gameInfo (scenario) wins; client scenario picks are random per client.
9. Challenge id for custom matches = lobbyId, CONFIRMED in-game (B6); `GAME_GET_CURRENT_SESSION.currentChallengeId` hint also uses lobbyId.
10. Spectator-host flow (`GAME_HOST_*`, `spectatorId`) is only partially understood; `GAME_HOST_CHALLENGE_STARTED` crash means it probably never worked via push.
11. Big Game pushes are not routed by the Nakama dispatcher -> mode probably unusable; confirm with a capture before investing.
12. Persisting pushes: undelivered `GAME_ACTION_PLAYED` while offline are not needed (replay via state API); `GAME_WON_BY_SERVER`/`GAME_MULTIPLAYER_RESULT` persisted **only for offline users** (a live push is never deleted by the client, so a persisted copy reappears at the next login, B6).
13. Rivals (card game) uses the same pipeline with `RivalsGameComponent`; blobs differ but transport identical. Not analysed separately.
14. No packet capture yet to confirm exact scriptData key casing for `GET_CURRENT_SESSION` gameInfo (read via `CreateFromGsData(resp.ScriptData, players)`, so flat gameInfo keys or a nested `gameInfo`/`scriptData` both work).
15. Server choices pending in-game confirmation (`server/src/mp_*.ts`, marked `ASSUMPTION:`):
    - ACTION_ID (CONFIRMED in-game): 111 only if ACTION_ID < last accepted for that seat (equal allowed: one context shares NetworkSyncId); exact durable retries (same seat+id+blob) are idempotent; a turntimer copy for an already accepted (seat, ACTION_ID) gets 111 (client maps it to SERVER_TURNTIMER_ACTION_ALREADY_PLAYED).
    - `allLastPlayedActionsPerPlayer` only lists seats that have played (mirrors client `ApplyedPlayedActionIds`).
    - MatchFound (CONFIRMED in-game): first `MatchmakingRequest` per matchId fixes seat order (its `playerIds`) + gameInfo (its scenario), pushes to all; later calls re-push to the caller; replays for a match older than 2 min are ignored (durable request replay after restart). Fields top-level (`matchId, participants, scriptData`), not under `data`.
    - `GAME_GET_CURRENT_SESSION` (handshake poll + cold-start rejoin CONFIRMED in-game): request hint `currentChallengeId` wins over the stored pointer; COMPLETED sessions are never reported (empty instead); `MatchmakingRequest` exits a stale running session of the caller.
    - Timers are lazy (no setTimeout in Nakama JS): ping timeout 60 s (only after HAS_STARTED_GAMELOGIC) -> pause; kick timer 180 s (if `useKicktimer`), AFK = 3 consecutive accepted turntimer expiries (reset by own regular action); `LEFT(FORCED_QUIT=True)`/`GAME_EXIT_SESSION` -> seat replaced by AI immediately, without kicked flag.
    - hostIdx = lowest seat of a present human, else lowest non-kicked human; re-elected on pause/return/kick.
    - Lobby: lobbyPlayers = members only; server maintains `sortedPlayerIds` on invite (appended; AI ids via LOBBY_INVITE become `aiPlayerIds`)/decline/kick/leave; any member may invite; owner leaving hands over to next member; canStart = all members ready (no min-human check).
    - ELO only for QUICK/AUTO match (K=32 pairwise over humans, clamp ±100), XP 100 winner / 50 others, karma 5; stored in `mp_stats` (not yet merged into account profile elo).
    - AI seats in playerDetails use `contentAiPlayers()` templates (id match) else `{id, isAi:true}`.
    - Pushes are non-persistent except `GAME_MULTIPLAYER_RESULT` to offline participants; ChallengeIssuedMessage is not sent (poll covers it, CONFIRMED in-game).
