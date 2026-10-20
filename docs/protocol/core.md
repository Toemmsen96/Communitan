# Core: transport + session layer

Source of truth = decomp at `$HOME/Documents/Decomps/Catan`. Cites are `Namespace/File.cs:line`.
Client = Nakama .NET SDK 3.17 + GameSparks emulation. Version consts: `ClientVersion=94`, `VersionName=2.7.5`, `BuildCode=512`, `BuildID=77fe79715` (Common/Versioning.cs:15-25), `NakamaHandler.Version=3.9.0`.

## 1. RPC envelope

### 1.1 Request (client -> server)
Every GS request is sent as `client.RpcAsync(session, rpcId, payloadJson)` (Nakama.Core/NakamaConnection.cs:495-511, called from :298-335).

| Item | Rule | Src |
|---|---|---|
| rpcId | `eventKey` field if present, else request type = `@class` minus leading `.` (e.g. `AccountDetailsRequest`, `MatchmakingRequest`, `ChangeUserDetailsRequest`) | NakamaConnection.cs:301,328,499 |
| payload | `GSRequest.JSON`: flat JSON object, all event attributes are TOP-LEVEL fields | GameSparks.Api.Requests/LogEventRequest_*.cs |
| `@class` | `".LogEventRequest"`, `".LogChallengeEventRequest"`, `".AccountDetailsRequest"` ... (leading dot) | GameSparks.Core/GSRequest.cs:28 |
| `requestId` | `"<DateTime.Now.Ticks>_<counter>"` added if missing; client keys pending map by it | NakamaConnection.cs:337-350 |
| `eventKey` | Present on LogEventRequest/LogChallengeEventRequest, e.g. `ACCOUNT_LOGIN` | LogEventRequest_ACCOUNT_LOGIN.cs |
| `challengeInstanceId` | extra top-level field on LogChallengeEventRequest_* | LogChallengeEventRequest_GAME_MULTICAST_TURNTIMERS.cs:19 |
| `scriptData` | object, only on Auth/Registration requests (`SetScriptData`) | GSTypedRequest.cs:52 |
| Session | RPC is sent with Bearer session token (not http_key) | NakamaConnection.cs:499 |
| Not logged in | any non-auth request with `session==null` or `client==null` is failed locally with `nakamaError:"NoNetwork"` | NakamaConnection.cs:303-326 |

Non-LogEvent GS request types that are RPC ids (no eventKey): `AccountDetailsRequest`, `MatchmakingRequest`, `ChangeUserDetailsRequest`, `ListGameFriendsRequest`, `PushRegistrationRequest`, `SendFriendMessageRequest`, `SendTeamChatMessageRequest`, `LeaderboardDataRequest`, `LeaderboardsEntriesRequest`, `GetLeaderboardEntriesRequest`, `CreateChallengeRequest`, `AcceptChallengeRequest`, `EndSessionRequest` (Common.Net/NakamaSender.cs: grep `new *Request()`; `EndSessionRequest` NakamaInstance.cs:404 on shutdown). Auth types (`AuthenticationRequest`, `RegistrationRequest`, `DeviceAuthenticationRequest`) are NOT RPCs, see section 3.

Minimal valid request (rpcId `ACCOUNT_LOGIN`):
```json
{"@class":".LogEventRequest","eventKey":"ACCOUNT_LOGIN","requestId":"638000000000000000_1",
 "APP_VERSION":94,"PLATFORM":"StandaloneWindows","LANGUAGE":"English","AUTHENTICATION_TYPE":"Device","VERSION_NAME":"2.7.5"}
```
(LogEventRequest_ACCOUNT_LOGIN.cs; attribute names are the UPPER_CASE setter names.)

### 1.2 Response (server -> client): RPC `payload` string
Flow: `Payload` -> `NakamaConnection.OnMessageReceived` -> `AddRequestedAction` (worker thread queue) -> `NakamaInstance.OnMessageReceived` -> `GSObject.FromJson` -> `ProcessReceivedItem` (NakamaInstance.cs:484-489, 1079-1104).

| Rule | Detail | Src |
|---|---|---|
| `@class` REQUIRED | must be non-null and end with `Response` -> goes to request matching. Ends with `Message` -> instead routed to `GSMessageHandler` (don't). Anything else is silently dropped; null `@class` NREs. | NakamaInstance.cs:1079-1099 |
| naming | `"." + RequestType.Replace("Request","Response")`: `.LogEventResponse`, `.LogChallengeEventResponse`, `.AccountDetailsResponse`, `.MatchmakingResponse`... The typed wrapper is chosen by the REQUEST type, not by `@class`; only the `Response` suffix matters. | CreateErrorResponse NakamaConnection.cs:513-533 |
| `requestId` REQUIRED | must echo request's `requestId` at top level, else no pending match -> callback never fires -> client synthesizes `{"@class":"ClientError","error":{"error":"timeout"}}` after 30s (`QueueTimeout`). | NakamaInstance.cs:1138-1158, 1049-1069; NakamaHandler.cs:47 |
| `scriptData` | object; all feature fields live here (`GSTypedResponse.ScriptData = GetObject("scriptData")`). A few responses read top-level fields instead (AccountDetails: `userId`,`displayName`,`currency1`,`currency2`) | GSTypedResponse.cs; PlayerDetails.cs:280-293 |
| error present | `ContainsKey("error")` -> `HasErrors`. If caller used `Send(ok, err)` the err callback fires, otherwise the single callback fires and caller must check `HasErrors`. | GSRequest.cs:77-98 |
| callbacks | run on Unity main thread via `ExecuteOnMainThread`. Durable requests (`SetDurable(true)`) are persisted + retried until ANY response whose `@class != "ClientError"` arrives -> server must be idempotent per `requestId` (client expects error key `requestId:"ALREADY_PROCESSED"` -> `RequestAlreadyProcessed`). | NakamaInstance.cs:1138-1191; Error.cs:40-45 |

Minimal valid response:
```json
{"@class":".LogEventResponse","requestId":"638000000000000000_1","scriptData":{}}
```
Errors have two surfaces:
1. **In payload (HTTP 200)**: `{"@class":".LogEventResponse","requestId":"..","error":{"errorCode":<int>,"customErrorMessage":"..","errorUri":".."}}`. `errorCode` must be a value of `Common.Net.ErrorCode` (Common.Net/ErrorCode.cs, e.g. 3 AccountDoesntExistOrWrongPassword, 27 NotLoggedIn, 53 LoginCacheCleared, 100 ClientVersionTooOld, 101 AdminMode, 102 Maintenance, 103 PlayerIsBlocked, 104 EmailNotVerified); unknown ints -> `Unknown`. (Error.cs:20-31)
2. **RPC failure (non-2xx)**: client builds `error:{"nakamaError":"<ApiResponseException.Message>"}` (NakamaConnection.cs:501-505). Message text = Nakama error `message`. `Error.Create` maps: `login_error`->605, `account_marked_for_deletion`->8, `Invalid credentials.`/`Exceeded max retry attempts.`->3, `Password must be at least 8 characters long.`->6, `User account not found.`->8, `Requested resource was not found.`->Unknown, `ClientVersionTooOld` (also wipes local app data), else `Enum.TryParse<ErrorCode>(message)` (so throwing `"MaintainanceModeActive"`, `"PlayerIsBlocked"`, `"AdminModeActive"`, `"LoginCacheCleared"` as message works), else 700 NakamaError. (Error.cs:128-157)
3. Legacy GS shapes also recognised inside `error`: `{message}`, `{requestId:"ALREADY_PROCESSED"}`, `{codeError:"codeIncorrect"}`, `{displayName:"already set"}`, `{DETAILS:"UNRECOGNISED"|"LOCKED"|"SHORT"}`, `{USERNAME:"TAKEN"}`, `{authentication:"NOTAUTHORIZED"}`, `{team:..}`, `{challengeInstanceId:"UNKNOWN|INVALID|COMPLETE"}`, `{leaderboardShortCode:..}`. Guild errors via `scriptData.guildData.error` ONLY when `error` is not an object (Error.cs:48-123, 168-192). `Error.Create` only fires if `error` is an object; a string `error` yields `Unknown`.
4. Side effects by code (NetworkResponseBase.cs:30-52): 102/101/103 -> `TerminateSession` (forced logout) + flag; 53 -> wipe local data + refetch.

Other queueing facts: sendQueue entries older than `QueueTimeout` (30s) are cancelled with `ClientError timeout`; `NakamaSender.callQueue` paces "non-critical" calls at 0.15s intervals (NakamaSender.cs:77,120-126) - so startup requests are serialized slowly (~6/s).

## 2. Notifications (server push)

Inbound paths, both -> `NakamaConnection.OnNakamaNotification` (NakamaConnection.cs:638-664):
- realtime: `socket.ReceivedNotification`
- at login: `ListNotificationsAsync(limit 100)` loop, each fed to the same handler, then ALL ids `DeleteNotificationsAsync` (NakamaConnection.cs:568-636). Subject `SessionTerminatedMessage` is skipped+deleted. Cursor loop re-adds the previous page (duplicates when >100 stored) and ends when `cacheable_cursor` is `""` or unchanged.

Handler logic:
1. `subject == "single_socket"` -> `TerminateSession()` (forced logout, "logged in elsewhere"). Nothing else read from it. (:640-647). This is Nakama core's own notification when `session.single_socket: true` is configured (verify in yaml).
2. `GSObject.FromJson(notification.Content)`; `@class` split on `.` takes `[1]` -> **`@class` MUST contain a dot** (`".ScriptMessage"`). No `@class` -> ignored (so Nakama system notifications with `{}` content are harmless).
3. `extCode = GetString("extCode")`; `NakamaInstance.ProcessMessage(obj, class, extCode)` (NakamaInstance.cs:547-702) -> enqueue into `NakamaCallbackInvoker` -> **ONE message dequeued per Unity frame** (NakamaCallbackInvoker.cs:31-35); unmatched class/extCode silently dropped.
4. `code`, `persistent`, `sender`, `create_time` are never read (create_time only logged at login list; `DateTime.Parse(CreateTime)` must parse or the whole login list aborts, :592). `subject` otherwise ignored.

Persistence advice (derived): persistent notifications are replayed once at next login and then deleted; ephemeral game traffic (`GAME_*`, `ACCOUNT_PLAYER_*`) should be `persistent:false` to avoid stale replays.

Message envelope (all classes): `{"@class":".ScriptMessage","extCode":"<EXT>","data":{...}}`. `ScriptMessage` also exposes `messageId,notification,title,subTitle,summary` but NakamaListener never reads them (grep of Common.Net/NakamaListener.cs found none) -> optional. Per-extCode `data` shapes belong to the feature docs; consumers in `Common.Net/NakamaListener.cs`.

### 2.1 Classes dispatched by ProcessMessage (everything else is DEAD over Nakama)
| `@class` (after dot) | extCode switch / notes |
|---|---|
| `ScriptMessage` | extCodes: FRIEND_FRIENDSHIP_{REQUESTED,DECLINED,ACCEPTED}, CHAT_EMOJI, GUILD_{NEW_REQUEST,REQUEST_ACCEPTED,REQUEST_NOT_ACCEPTED,CLOSED,GOT_KICKED,REMOVED_PLAYER,GMOTD_UPDATE}, LOBBY_{GOT_KICKED,START_GAME,UPDATE_PLAYERS,UPDATE_GAMEINFO,INVITE}, **MatchFoundMessage** (extCode, not class!), GAME_{START_GAMELOGIC,SCENE_LOADED,PAUSED,ACTION_PLAYED,MULTICAST_TURNTIMERS,ACTION_TURNTIMER_PLAYED,HOST_CHALLENGE_ISSUED,HOST_CHALLENGE_STARTED,HOST_CHALLENGE_DRAWN,UNIQUE_IDS_UPDATE,TRADE,MULTIPLAYER_RESULT,PLAYER_AFK_KICKED,WON_BY_SERVER,STATE_REQUESTED,PLAYER_WAS_KICKED}, LEVEL_PROGRESS, ACCOUNT_{PLAYCATAN_BONUS_UNLOCKED,SHOW_RATING_REMINDER,PLAYER_CONNECTED,PLAYER_DISCONNECTED}, SYS_MAINTENANCE, SHOP_PURCHASE_RESPONSE (NakamaInstance.cs:581-697) |
| `FriendMessage`, `TeamChatMessage`, `AchievementEarnedMessage`, `ChallengeIssuedMessage`, `ChallengeAcceptedMessage`, `SessionTerminatedMessage` | top-level GS message classes (fields per GameSparks.Api.Messages/*.cs) |
| `OnChallengeJoined` | note odd class name (not `ChallengeJoinedMessage`) -> invoker builds `ChallengeJoinedMessage` |
| `ChallengeChatMessage` | dispatched but invoker case is a no-op (NakamaCallbackInvoker.cs:181) |

Listeners registered but NEVER dispatched by ProcessMessage (dead on Nakama; don't implement): BIG_GAME_{ACTION,BUILD,BUILD_FINAL_LEADERBOARD,WON,WON_BY_SERVER}, TOURNAMENT_PLAYER_UPDATE (!), SEASON_{UPCOMING,UPDATED}, PUSH_NOTIFICATION, GAME_PLAYER_VOTED, GAME_TRADE_PREFS_CHANGED, GAME_CUSTOM_MATCH_REAL_TIME_CREATED, MATCH_HANDSHAKE_FAILED, MatchUpdated/MatchNotFound/ChallengeDrawn/Lost/Started/Declined/Won/Waiting..., NewHighScore, *RankChanged. (Compare NakamaListener.cs:163-217 vs ProcessMessage.) NB: BigGame/Tournament listeners exist but the pushes cannot reach them; features there must rely on RPC polling (BIG_GAME_GET_TURNS, TOURNAMENT_GET_*).

`MatchFoundMessage` (extCode) payload read at NakamaListener.cs:229-234: top-level `matchId`, top-level `participants[]` (player objects, parsed by `PlayerDetails.Create`), `scriptData` (game info for `MultiplayerGameInformation.CreateFromGsData`).

## 3. Auth

Client always connects with `new Client(scheme, host, port, serverKey)` (GameSparks.Platforms/DefaultPlatform.cs:26) then one of three auth calls; success is followed by `socket.ConnectAsync(session, appearOnline:true, timeout 15s)` (NakamaConnection.cs:251-279). `RetryConfiguration(500ms,1)` on email/device, `(0,1)` on custom.

| Flow | SDK call | Args | Src |
|---|---|---|---|
| Email login | `AuthenticateEmailAsync(userName, password, displayName(null), create:false, vars)` | userName = lower-cased email; password plain | NakamaConnection.cs:443-493; NakamaSender.cs:274 |
| Register | same, `create:true`, `username=displayName` (trimmed) | email lower+trim | NakamaSender.cs:231-247 |
| Device (guest) | `AuthenticateDeviceAsync(id, username=request.email(null), create:true, vars)` | `id = "295012-" + DeviceOS + "-" + DeviceId` e.g. `295012-WINDOWS-<SystemInfo.deviceUniqueIdentifier>` (AppId const `295012`, PlatformBase.cs:167; DeviceOS from RuntimePlatform: WindowsPlayer->`WINDOWS`, Linux->`LINUX`, PlatformBase.cs:37-72). If `isMigrating` key present: `id = request.deviceId` (email->device migration; never set by game code) | NakamaConnection.cs:383-441 |
| Reconnect | `AuthenticateCustomAsync(id=sha256hex(lowercase) of stored JWT, username=savedPlayerId, create:false, vars)` | stored JWT = `session.AuthToken` from the last email/device login, kept in `user.config` (`AuthenticationDetails.NakamaToken` / `NakamaTokenExp`) | NakamaConnection.cs:352-381,281-296; AuthenticationDetailsSerializer.cs:66-67 |

Reconnect server requirements:
- After every email/device/register auth the server must `linkCustom(userId, sha256hex(newSession.token))` (e.g. `afterAuthenticateEmail/Device` hooks get the session in `data.token`), otherwise `create:false` -> 404 -> `ApiResponseException` -> `TerminateSession` (full logout, NakamaConnection.cs:368-373).
- Client only tries reconnect if `NakamaTokenExp - now >= 0`; `NakamaTokenExp = (int)session.ExpireTime` (int cast; fine until 2038). Nakama default `session.token_expiry_sec` is 60s -> raise (days/weeks) or reconnect never works. Expired token -> `TerminateSession` (:553-559).
- Quirk: `ExpireTime` is only set on email/device auth, not on custom auth (:362 vs :402,451) -> after a reconnect, next `SaveAuthenticationDetails` stores exp 0.
- Stored auth also invalidated client-side if `BuildCode != 512` or `EnvironmentType != current` (AuthenticationDetails.cs:43-50).
- Token is also sha256'd client-side from the JWT string, so server must hash exactly the `token` string returned to client.

### 3.1 Vars (session.Vars) the client sends
- Email/Device/Register: `vars` = EVERY field of the GS request flattened to strings (nested objects as JSON string): `@class`, `requestId`, `userName`, `password`(!), `displayName`, `deviceId`, `deviceOS`, `deviceType`, `operatingSystem`, `email`, and `scriptData` = JSON string of `{appVersion, currentPlatform, isDeviceTransfer, oldDisplayName, gsDeviceId("295012-OS-id"), lang, versionName, deviceId(SystemInfo uid), authenticationType}` (NakamaConnection.cs:386,445; NakamaSender.cs:299-316). Server hooks should read `appVersion` (compare to 94) from `JSON.parse(vars.scriptData)`. Strip `password`/`@class`/`requestId` in a `beforeAuthenticate*` hook if size/leaks matter.
- Custom reconnect: flat `GetScriptData()`: `appVersion`, `currentPlatform` (= `Application.platform.ToString()`, e.g. `WindowsPlayer`), `lang`, `versionName`, `deviceId`, `authenticationType` (`Device|Credentials|invalid`) (NakamaConnection.cs:226-249).
- Possible `authenticationType` values: Common.Net/AuthenticationType.cs.

### 3.2 What the client reads back (AuthenticationResponse)
Client SYNTHESIZES the auth response locally (it is not a server payload): `{@class:".AuthenticationResponse", requestId, ...all session.Vars key/values..., error?}` (NakamaConnection.cs:407-431,456-490). Consumers: `NetworkResponseBase.InitializeWithResponse` -> only `Error.Create` (error field); `resp.UserId` only in a log line (NakamaSender.cs:283). **The server does NOT need to set `userId`/`displayName`/`newPlayer`/`authToken`/`switchSummary` vars.** Real user id comes from `session.UserId` (JWT `uid`) -> `NakamaInstance.SetUserId` -> `AuthenticatedEvent` (NakamaConnection.cs:260, NakamaInstance.cs:533-545).
Auth error surfaces: `ApiResponseException.Message` -> `error.nakamaError` (see 1.2). Specific: `"User account not found."` (email login unknown) -> 8 AccountDoesntExist (= "possible migration") and the connection is NOT disconnected; every other failure calls `Disconnect()`. Use stock Nakama messages: `Invalid credentials.`, `User account not found.`, `Password must be at least 8 characters long.`; custom: throw/return `login_error`, `account_marked_for_deletion`, `ClientVersionTooOld`, `MaintainanceModeActive`, `PlayerIsBlocked`, `AdminModeActive`, `Exceeded max retry attempts.` (from a `before*` hook).
Email-verification: login succeeds at Nakama level; `needsEmailVerification` is read from `AccountDetailsRequest.scriptData` (PlayerDetailsResponse.cs:32) -> UI goes to RegisterStep2; codes via `ACCOUNT_EMAIL_VERIFY{code,email}` / `ACCOUNT_RESEND_ACTIVATION_CODE{email}`. Password reset (unauthenticated!) uses a TEMP device login first, then `ACCOUNT_CHANGE_PASSWORD_REQUEST` / `ACCOUNT_CHANGE_PASSWORD` (NakamaConnector.cs:71-106).

Steam: NO Steam auth ticket is used for login (Steamworks only for language, achievements, payments: GameRoot.cs:166-170, Common.Payment/SteamPaymentSystem.cs:26-70 sends steamId as plain strings to RPCs). Device id is the only identity for guests.

## 4. Startup sequence (after launch to usable main menu)

Pre-login: no RPCs. `NakamaConnector.SetupStartMenuState` (NakamaConnector.cs:251-280) loads `user.config`; stored valid auth -> `SetupAuthData` + `StartGameSparks` (auto custom auth, section 3) -> Main; else Login screen. `StartGameSparks` adds `NakamaUnity`/`DefaultPlatform` (HTTP client created, `Activate()` sets Ready=true immediately; no handshake).

| # | Step | Type | Blocking? | Src |
|---|---|---|---|---|
| 1 | Auth (email/device/custom) | Nakama auth | yes | NakamaConnection.cs |
| 2 | `ConnectAsync` socket (15s) -> `Available=true` -> `SetUserId` -> `AuthenticatedEvent(userId)` | socket | yes | :251-262 |
| 3 | `ListNotifications(100)` + replay + `DeleteNotifications` | Nakama REST | no (caught) | :568-636 |
| 4 | `AuthenticationChanged` fires immediately on step 2 (if AuthType valid and not authenticating) -> fan-out of feature loaders (see 4.1) | - | - | Authentication.cs:334-342 |
| 5 | `ITEM_GET_PRODUCT_ITEMS {CATEGORIES:[Color,Item,BoardTable,BoardPieces,BoardTile]}` (skipped if local cache fresh). scriptData keys `Color`,`Item`,`BoardPieces`,`BoardTable`,`BoardTile` | RPC (callQueue) | soft: failure still unblocks | AuthenticationBase.cs:64-76; AvatarContentController.cs:363-377; NakamaSender.cs:3726-3770 |
| 6 | `ACCOUNT_LOGIN {APP_VERSION,PLATFORM,LANGUAGE,AUTHENTICATION_TYPE,VERSION_NAME}` -> error aborts login, UI back to login | RPC (callQueue) | **YES** | NakamaSender.cs:320-349 |
| 7 | `AccountDetailsRequest` (no eventKey). Needs top-level `userId`,`displayName`,`currency1`(gold),`currency2`(tickets) - null `.Value` NRE if absent; `scriptData`: `authenticationType`,`lastSeenTOS`,`lastSeenAGB`(ms),`needsEmailVerification`,`scrollsEnabled`,`aiPlayerVersion`,`almanacVersion`,`virtualGoodsVersions`,`aspirantForGuildId`,`virtualGoods{}`,`guildName`,`expansions`,`level`,`xpForThisLevel`,... (PlayerDetails.cs:300+) | RPC | **YES** (error -> login treated as failed, `SetupAuthentication(None)`) | AuthenticationBase.cs:80-100,Authentication.cs:355-368; NakamaSender.cs:420-495 |
| 8 | side fetches inside #7 handler: `GAME_GET_AI_PLAYERDETAILS`, `ALMANAC_GET_DATA`(if version stale), `SHOP_*` product check (ShopContentController.CheckForProductsOnLogin) | RPC | no | NakamaSender.cs:430-480 |
| 9 | `TERMS_GET_TOS {LANGUAGE}` then `TERMS_GET_AGB {LANGUAGE}`. scriptData: `TOS`+`tosDate`(ms) / `AGB`+`agbDate`. **On error `onDone` never fires -> login spinner hangs forever** | RPC | **YES** | Authentication.cs:388-410; NakamaSender.cs:691-730; TOSResponse.cs |
| 10 | Login callback -> Main state. New device user gets name popup -> `ChangeUserDetailsRequest{displayName}` (error `displayName:"already set"` => name taken) | RPC (durable) | no | LoginState.cs:260+; NakamaSender.cs:404-418 |
| 11 | MainState: `SERVERNEWS_GET {LANGUAGE}` once per session (+`SERVERNEWS_MARK_SEEN`) | RPC | no | MainState.cs:128-135; NakamaSender.cs |
| 12 | `GAME_GET_CURRENT_SESSION {REMOVE_WAS_KICKED_FLAG, CurrentChallengeId}` rejoin check when main menu idle and authenticated; response `currentChallengeId`,`challengeState`, ... | RPC | no (but needed for rejoin) | MatchReconnectHandler.cs:25-100; FindRunningSessionState.cs:33; NakamaSender.cs:929-970 |

### 4.1 Fan-out on `AuthenticationChanged` (all optional / non-blocking; each its own file)
FriendsCollection -> `ListGameFriendsRequest` + `FRIEND_GET_ONLINE`; Mails -> `MAIL_GET_LATEST_MAILS`; Blacklist -> `BLACKLIST_GET_BLOCKED_PLAYERS`; Promotion -> `PROMOTION_GET_PLAYERS_PROMOTIONS`; MetaTutorial -> `META_TUTORIAL_GET_PROGRESS`; Seasons -> `SEASON_GET_SEASONS_DETAILS`; Tournaments -> `TOURNAMENT_GET_CONFIG` + `TOURNAMENT_GET_MY_LIST`; BigGame -> `BIG_GAME_GET_TURNS`; Shop -> `SHOP_GET_DISCOUNT_OR_NEW_OFFERS`; Push opts -> `PUSH_NOTIFICATIONS_GET_OPTIONS`; Almanac etc. Missing/erroring ones only disable their UI (errors go through `OnError` -> `ErrorEvent` popups: NakamaSender.cs:128-153). `LocalPlayer.UpdateDetailsFromServer` (AccountDetailsRequest) is re-polled every 180s in MainState (MainState.cs:15,56-60).
Each of those handlers uses `Authentication.IsAuthenticated` = `!blocked && !maintenance && !admin && NakamaHandler.Authenticated(available && AuthToken!=null) && AuthType valid` (Authentication.cs:81-91).

In-game keepalive: `NakamaPing` every 25s only while in a multiplayer game (NakamaPing.cs:20-90; sends a turn-timer event; kick offset assumes 35s server timer).

## 5. Socket usage

### 5.1 Matchmaker (discovery only)
Flow (MatchStartState.cs:70-150, NakamaInstance.cs:704-905, NakamaConnection.cs:666-701):
1. (authenticated) client calls RPC `GET_BLOCKED_AND_FRIEND_IDS` -> scriptData `blocked:[userId]`, `friends:[userId]` (NakamaInstance.cs:704-745). Must return arrays (empty ok).
2. `socket.AddMatchmakerAsync(query, minCount, maxCount, stringProps, numericProps)`; ticket stored.
3. On `ReceivedMatchmakerMatched`: ignored unless `matched.Ticket` equals the stored latest ticket; then `JoinMatchAsync(matched)` (token join -> works with default RELAYED matches; do not return an authoritative match id from matchmaker_matched hook unless it supports presence join by token), then `JoinChatAsync(match.Id, Room, persistence=true, hidden=false)`.
4. `FinalizeMatchmaking(match, matchedUsers)` (all matched clients run it): returns silently if `match.Size < Min-1 && users < Min-1`; computes intersection of users' `scenarios` string-property (space split), filters 5/6p vs <5p scenarios and `3Players`/`4Players` by count, picks random one into `GameInfo` (Rivals: sets mode/themes), then RPC **`MatchmakingRequest`** (durable) with `matchShortCode` (`AUTOMATCH_2P|3P|3P_4P|...|FREEMATCH_2P/3P|BIG_GAME`), `participantData{..,karma,friends,guildMembers}`, `matchData`, `skill`, `customQuery`, `playerIds:[userIds]`, `matchId:<nakama match id>` (MatchmakingRequestHelper.cs; NakamaSender.cs:1163-1188). Cancel = same RPC `{action:"cancel", matchShortCode}`.
5. Then client `LeaveMatchAsync(match)` and clears the ticket.
6. Server RPC handler must create the game ("challenge") - use `matchId` as the challengeId so chat room (match id) == `GameInfo.ChallengeId` (RetrieveMessageHistory/rejoin joins room by ChallengeId, NakamaConnection.cs:792-831) - and dedupe (N clients call it) then push `ScriptMessage/MatchFoundMessage` to each participant (section 2.1). Error path: response `error` -> `MatchState.WaitForMatch` OnError. Optional BigGame prematch returns scriptData `bigGameId,startDateTime,timeLeftInMs`.

Query string (Common.Net.Nakama/NakamaQueryConfig.cs:ToString ~ line 195-230), space-joined:
`+properties.matchType:<AnalyticsMatchType> +properties.expansions:/.*(A|B).*/ +properties.scenarios:/.*(S1|S2).*/ [+properties.skill:>=S-d +properties.skill:<=S+d] +properties.karma:>=k-1 +properties.karma:<=k+1 (+ only if karmaOnly) +properties.appVersion:94 [+properties.rivalsThemeSetWishlist:..] [+properties.tournamentId:..] [+properties.friends:/.*<uid with - escaped>.*/] [+properties.guild:..] (+properties.seasonId:<id> | -properties.seasonId:/.+/)`.
Quick/custom (non-auto) match uses `/.*X.*/` single-value regex on first expansion/scenario instead of group.
- stringProperties: `matchType`(=`gameInfo.Match.ToString()`, NOTE differs from query's `AnalyticsMatchType`), `expansions`, `scenarios` (space-joined), `karmaOnly`,`friendsOnly`,`guildsOnly` ("true"/"false"), optional `tournamentId`,`seasonId`,`rivalsThemeSetWishlist`,`friends`(space-joined ids),`guild`.
- numericProperties: `skill` (elo for first expansion), `karma`, `appVersion` (94).
- min/max count: `gameInfo.MinPlayers/MaxPlayers` (2/2, 3/4, 3/3, 4/4, 5/6, 5/5, 6/6).
- skill widening: client cancels and re-adds ticket every 60s with thresholds d = 100, 200, 300 (all three tiers use symmetric d) (NakamaQueryConfig.cs DetermineThreshold; MatchWaitState.cs:114-165). Server should keep `matchmaker.interval_sec` small (default 15) and allow `max_tickets>=1`.

### 5.2 Chat (match room)
- Join: room `JoinChatAsync(match.Id | ChallengeId, ChannelType.Room, persistence:true, hidden:false)` (NakamaConnection.cs:777-790).
- Send: `WriteChatMessageAsync(channel.Id, {"<subject>":"<text>"})`; default subject `"message"` -> content `{"message":"hi"}` (:833-860). Receiver parses `content` JSON and reads only `message` (ChatMessage.cs:41-57); sender display name looked up in `PlayerCollection` by `message.SenderId` (must be a known player id).
- History: `ListChannelMessagesAsync(session, channelId, 30)` replayed through the same path (:819-823). `ReceivedChannelMessage` only handled when `ChannelId == joined channel id` (:867-873; NRE if never joined).
- Guild/friend/team chat do NOT use sockets: `SendTeamChatMessageRequest`/`SendFriendMessageRequest` RPCs + `TeamChatMessage`/`FriendMessage` notifications.

### 5.3 Status / presence / groups
- `socket.ReceivedStatusPresence` only logged (:887-897). `FollowPlayersStatus`, `UpdateStatus`, `UnfollowPlayersStatus` (:899-946) are private and never called -> dead. Online state comes from `FRIEND_GET_ONLINE` RPC and `ACCOUNT_PLAYER_CONNECTED/DISCONNECTED` ScriptMessages.
- `GetGroupUsers` -> `ListGroupUsersAsync(group,null,100)`, `GetUserGroups` -> `ListUserGroupsAsync(userId, memberType, 100)` (:948-973): public but NO callers in the decomp -> dead. Guilds are implemented purely with RPCs (GUILD_* ScriptMessages). Same for NakamaQueryConfig.AddFriendsUsersIds (unused).
- `ConnectAsync(appearOnline:true)`: user shows as online in Nakama.
- Socket errors: `WebSocketClient_OnError` only reacts to strings "INVALID LOCATION"/"UNKNOWN SERVICE" (Disconnect). Socket close -> connection `stopped` -> main loop creates a new connection and re-auths via custom auth (backoff `RetryBase 2s .. RetryMax 60s` + 30s host timeout) (NakamaInstance.cs:1256-1294,1340-1366).

### 5.4 Server status (custom, not in the game) `COMMUNITAN_STATUS`
kind: RPC (own handler, `server/src/status.ts`) · req: none · resp: `{online, playing, searching, modes:{<modeKey>:{searching, playing}}, rng:"off"|"seeds"|"full", entitlements:"free"|"owned"|"dev", name?, motd?}` (`rng` = `CATAN_SERVER_RNG`, docs/design/server-rng.md; `entitlements` = `CATAN_ENTITLEMENTS`, `dev` = local-testing unlock, tools/README.md, economy-ranking.md 2a)
- Public: `GET|POST /v2/rpc/COMMUNITAN_STATUS?http_key=<runtime.http_key>&unwrap` (verified 3.41: GET and POST with empty/`{}` body; without `unwrap` the body is `{"payload":"<json string>"}`; wrong key -> 401). `http_key` = `NAKAMA_HTTP_KEY`, default `catan-public-status`, treated as public. `rpcDispatch` refuses every id without `ctx.userId` (`error.code UNAUTHORIZED`) except `COMMUNITAN_STATUS`; nothing legit calls RPCs server-to-server.
- In game (session): same RPC id with a GS `LogEventRequest` `eventKey:COMMUNITAN_STATUS` -> counts as `scriptData`.
- `modeKey` = `<matchType>|<expansions sorted, comma-joined>|<min>-<max>`: matchType/expansions = matchmaker stringProperties `matchType` (`gameInfo.Match`) and `expansions` (space list), min/max = matchmaker counts (`gameInfo.MinPlayers/MaxPlayers`; base quick match is 3-3 by default). Sessions use gameInfo `matchType`/`expansions`/`minPlayers`/`maxPlayers`. E.g. `QUICK_MATCH|CatanBaseGame|3-3`.
- searching: RT before-hooks `MatchmakerAdd` (writes per-user `communitan_search/ticket {mode, ts}`) / `MatchmakerRemove` (deletes), `matchmakerMatched` hook deletes the matched users' docs and returns nothing (default relayed token match stays). Counted if `ts` < 75 s (client re-adds every 60 s) and the user is online.
- online: per-user `communitan_online/seen` marker refreshed by authenticated RPCs (<= every 10 min per VM); counted while Nakama's status registry reports the user online (socket with appearOnline). JS runtime has no session start/end events (Go only).
- playing: humans of `RUNNING` `sessions` docs (updated < 10 min) not kicked/paused and seen < 2 min. Cached 2 s per VM. `name`/`motd` from `data/news.json` `serverName`/`motd`.

## 6. Config

| Item | Value | Src |
|---|---|---|
| `NakamaConfig` | `{scheme, host, port, serverKey}` fields only | Nakama.Core/NakamaConfig.cs |
| Env pick | `CommandLineController.Environment` (default `Production`; override CLI arg containing `env=Local|Development|Staging|Production`) -> `ConfigLOCAL/DEV/QA/PROD` (QA = Staging) | NakamaInstance.cs:1328-1338; Common/CommandLineController.cs:97-100,119 |
| Config values | Unity asset `Resources/NakamaSettings` (`NakamaSettings.NakamaConfigPROD` ...), not in decomp. Re-read on every `new NakamaConnection(...)` (this is what our BepInEx plugin patches: Patches.cs:83-92) | NakamaSettings.cs; PlatformBase.cs:129 |
| HTTP timeout | `client.Timeout = 30` s | NakamaHandler.cs:55 (`RequestTimeout`) |
| Socket connect timeout | 15 s | NakamaHandler.cs:57 |
| Request queue timeout | 30 s (`QueueTimeout`, `HostQueueTimeout`) | NakamaHandler.cs:47-49 |
| Retry | base 2 s, max 60 s; durable: 1 concurrent, drain 100 ms; migration timeout 20 s | NakamaHandler.cs:43-59 |
| Durable queue | persisted per user id (`SetUserId` re-inits) | NakamaInstance.cs:533,1106 |
| Server key | used only for auth endpoints (Basic auth); socket + RPC use the session | SDK |

CDN: `https://cdn.catancdn.de/nk/nk-prod/bundle/` is the default remote AssetBundle URL, composed as `{AssetBundleURL}{BuildID=77fe79715}/{platform folder}` (Common/CommandLineController.cs:24,113; Common.AssetBundles/CatanAssetLoader.cs:15-17). It is USED ONLY if CLI `remoteAssetBundles=true` (`AssetBundleManager.UseRemoteAssetBundles` defaults `false`, AssetBundleManager.cs:10); default loads `StreamingAssets/AssetBundles/`. `bundleURL=<url>` overrides. Other hardcoded URLs: `https://support.catanuniverse.com/hc/...` (help only). No other host is hardcoded; everything else goes through Nakama.

## 7. Open questions
1. `NakamaSettings` asset values (official hosts/ports/scheme/serverKey per env) are not in the decomp - read from game `resources.assets`/Player.log if needed; irrelevant for custom server but confirm `serverKey` the official prod used.
2. Does stock Nakama emit the `single_socket` notification (subject exactly `single_socket`) when `session.single_socket: true`? Verify against Nakama 3.21 source/docs; otherwise server must `notificationSend` it itself.
3. `matchType` mismatch: query uses `AnalyticsMatchType`, stringProperty uses `Match` - check both enums produce equal strings in AUTO_MATCH/QUICK_MATCH, else matches never form (capture a real `AddMatchmakerAsync` log line, NakamaConnection.cs:725).
4. `FinalizeMatchmaking` early-return guard `match.Size < Min-1`: with relayed match join `match.Size` includes only joined presences; confirm it passes for 2p.
5. What does the official server do with `GET_BLOCKED_AND_FRIEND_IDS` when user has none (client treats empty list as null)? any case fine.
6. Token lifetime: client refresh path is never used (no `SessionRefreshAsync`); confirm desired `session.token_expiry_sec` (official likely very large because `NakamaTokenExp` is stored as int32).
7. `vars` contain the plaintext `password` (flattened request) - strip in `beforeAuthenticateEmail` to keep it out of JWTs.
8. Exact `ClientVersion` gate: official presumably rejects `appVersion < min` with `ClientVersionTooOld`; min value unknown (current 94).
9. Durable request replay: duplicate `requestId` may arrive after timeouts; server idempotency store needed (error `requestId:"ALREADY_PROCESSED"` expected).
10. One notification dispatched per frame: bursts (e.g. many `GAME_ACTION_PLAYED`) are rate-limited by the client at frame rate; ordering is FIFO only per arrival order, so server must send in order.
11. Notification-list login replay can contain stale `GAME_*` messages if sent persistent - need per-extCode persistence policy (feature docs).
12. `DateTime.Parse(item.CreateTime)` in login replay: Nakama emits RFC3339, expected OK.
