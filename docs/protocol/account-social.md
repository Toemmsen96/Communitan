# Account / social / misc protocol

Scope: ACCOUNT_*, FRIEND_*, GUILD_*, BLACKLIST_*, GET_BLOCKED_AND_FRIEND_IDS, MAIL_*, CHAT_GET_PLAYER_ID, CHAT_SEND_TO_PLAYER_ID, TERMS_*, PUSH_NOTIFICATIONS_*, SERVERNEWS_*, META_TUTORIAL_*, TUTORIAL_*, ALMANAC_*, ERROR_*, TEST_*, MAINT*, standard GS requests, account/social pushes.
Format: see `CLAUDE.md`. All `src:` are decomp paths (`Namespace/File.cs:line`). `NS` = `Common.Net/NakamaSender.cs`. `dead` = no caller outside the generated request class.
Every LogChallengeEventRequest_* twin of these keys is unused (no caller) -> not listed.

## 0. Envelope facts that matter here

- RPC id = `eventKey` (LogEvent) or request class name minus nothing (`AccountDetailsRequest`, `ListGameFriendsRequest`, ...). Payload = full GS request JSON (`@class`,`requestId`,`eventKey`, params at top level). Nakama.Core/NakamaConnection.cs:328 (id), :495-499 (send).
- Success reply: `{"@class":".LogEventResponse","requestId":<echo>,"scriptData":{...}}`. Client reads `scriptData` via `response.GetObject("scriptData")`; **many callers deref it without a null check -> always return `scriptData:{}` at minimum.** GameSparks.Core/GSTypedResponse.cs:13.
- Error reply: top-level `"error":{...}` (presence of key = `HasErrors`). Mapped in Common.Net/Error.cs:15-200:
  - `{"errorCode":<int>,"customErrorMessage":?,"errorUri":?}` -> `ErrorCode` enum (Common.Net/ErrorCode.cs; table in sec. 4).
  - `{"nakamaError":"<str>"}` -> string switch (Error.cs:150-180): `login_error`, `account_marked_for_deletion`, `Invalid credentials.`, `User account not found.`, `Password must be at least 8 characters long.`, `ClientVersionTooOld` (also wipes local data), else `Enum.TryParse<ErrorCode>(str)` (so a thrown RPC error with message `MaintainanceModeActive` etc. works).
  - Any thrown RPC error (ApiResponseException) is turned into `{"nakamaError":<exception message>}` client-side (NakamaConnection.cs:499-530) -> **RPC error message text is the error code name.**
  - Legacy GS shapes also understood: `{"DETAILS":"UNRECOGNISED|LOCKED|SHORT"}`, `{"USERNAME":"TAKEN"}`, `{"codeError":"codeIncorrect"}`, `{"displayName":"already set"}`, `{"team":"INVALID|NOT_A_MEMBER"}`, scriptData.guildData.error (guild section).
- Push = Nakama notification, `content` JSON `{"@class":".ScriptMessage","extCode":"X","data":{...}}`; standard msgs use their own `@class` (`.FriendMessage`, `.TeamChatMessage`, `.AchievementEarnedMessage`, `.SessionTerminatedMessage`) with fields at top level. Dispatch: Nakama.Core/NakamaConnection.cs:632-660 -> Nakama.Core/NakamaInstance.cs:548-700. Notifications sent while offline are fetched + deleted on socket open (NakamaConnection.cs:570-630) -> use **persistent** notifications. Notifications without `@class` (Nakama built-in friend/group ones) are silently ignored.
- Dispatch of the `Listener` for a push `X` is by `extCode` for `ScriptMessage`; `PUSH_NOTIFICATION` is NOT in the switch (dead).

## 1. Player profile data model

Login chain (all must succeed to reach main menu): auth (see auth doc) -> `ITEM_GET_PRODUCT_ITEMS` avatar download (not in this doc; `AuthenticationBase.OnGSAuthenticated`, Common.Net/AuthenticationBase.cs:50-74; blocks login if it fails) -> `ACCOUNT_LOGIN` (:94) -> `AccountDetailsRequest` (:120) -> `TERMS_GET_TOS` -> `TERMS_GET_AGB` (Common.Net/Authentication.cs:392-410) -> login done. Then in parallel on AuthenticationChanged: FRIEND list, BLACKLIST list, MAIL, ALMANAC, META_TUTORIAL_GET_PROGRESS, TUTORIAL_GET_PROGRESS, SERVERNEWS (main menu).

### 1.1 `AccountDetailsRequest` response (own profile) - **login-critical**

Parsed by `PlayerDetails.CreateFromAccountDetails` (Common.Net/PlayerDetails.cs:283-297) + `GetPlayerDataFromGSData` (:300-405) + `PlayerDetailsResponse.InitResponse` (Common.Net/PlayerDetailsResponse.cs:22-45). Top-level = GS `AccountDetailsResponse`; everything else under `scriptData` (parser prefers `scriptData` when present).

```jsonc
{
  "@class": ".AccountDetailsResponse", "requestId": "...",
  // --- top level (GameSparks.Api.Responses/AccountDetailsResponse.cs) ---
  "userId": "uuid",              // string  -> Details.Id ; REQUIRED
  "displayName": "Name",         // string  -> Details.Name ("" if missing -> client treats as unnamed -> name-your-player state)
  "currency1": 0,                // int  -> GoldAmount ; REQUIRED: `.Value` on null throws (PlayerDetails.cs:290)
  "currency2": 0,                // int  -> TicketsAmount ; REQUIRED, same reason
  "scriptData": {
    // account / flags
    "authenticationType": "Device|Credentials|Migration", // string enum; missing -> "invalid" => client treats as logged out. mirror the value the client sent in ACCOUNT_LOGIN.AUTHENTICATION_TYPE
    "lastSeenTOS": 0,            // long ms-epoch; compared with TERMS_GET_TOS.tosDate (informational only, result not acted on)
    "lastSeenAGB": 0,            // long ms-epoch
    "needsEmailVerification": false, // bool; true => RegisterStep2 (email code) screen. Ours: true only for email accounts registered while CATAN_EMAIL_VERIFICATION=ingame and not yet verified
    "scrollsEnabled": true,      // bool, default true (LocalPlayer.EnableScrolls)
    "aspirantForGuildId": "gid", // optional string; pending guild join request
    // versions that trigger sub-downloads
    "aiPlayerVersion": 1,        // optional int; absent => client re-sends AI-player-details request (not this doc)
    "almanacVersion": 1,         // optional int; if > cached => ALMANAC_GET_DATA
    "virtualGoodsVersions": 1,   // optional int; absent => shop CheckForProductsOnLogin (shop doc)
    // progression
    "level": 1,                  // long, default 0
    "xpForThisLevel": 0,         // long -> Details.Xp  (NOTE name; "xp" is not read)
    "xpFromThisLevelToNext": 100,// long
    "xpBoost": 1.0,              // float, default 1
    "karma": 3.0,                // double, default 3.0 (matchmaking uses +-1)
    "elo":          { "CatanBaseGame": 1000.0 },   // map ExpansionsEnum name -> double; only listed keys are used
    "eloPlacement": { "CatanBaseGame": 0 },        // map name -> int placement matches played
    // entitlements
    "expansions": 3,             // long BITMASK of ExpansionsEnum (1 Base,2 Seafarer,4 C&K,8 RivalsBase,0x10 AgeOfDarkness,0x20 AgeOfEnlight,0x40 Arrival,0x80 Inkas,0x100 EOE,0x200 Explorers,0x400 EOB,0x800 BigGame,0x1000+ seasons). Set all bits to unlock everything.
    "expansionsViaPromoFlag": 0, // optional long bitmask (promo-granted)
    "virtualGoods": { "ITEM_ID": {...} }, // map; only KEYS are read -> Details.OwnedItemIds
    "currency1": 0, "currency2": 0,        // optional repeat; if present overrides top-level
    "canCreateTournament": true, "canCreateTournament_beta": false, "canCreateFreeTournament": false,
    "guildName": "",             // string; non-empty => IsInGuild()  (guild screens call GUILD_GET_DETAILS for the rest)
    "appVersion": 0,             // optional int
    // sun system (free-play passes for unowned expansions)
    "suns": { "permanent": 1, "temporary": 0, "reloadTimes": ["2026-01-01T00:00:00Z"] }, // absent => SunSystem null (UI tolerates; USE_SUN only called when expansion not owned)
    // avatar  (PlayerAvatar.UpdateFromGSData, Common.AvatarSetup/PlayerAvatar.cs:61-121)
    "lastAvatarChangeTime": 0,   // long; client ignores older updates (TimeCode)
    "sex": "Male|Female|Pet",    // missing/invalid => defaults (Female + default items)
    "skincolor": "COLOR_ID",     // string id from ITEM_GET_PRODUCT_ITEMS Color list
    "eyecolor": "COLOR_ID",
    "equipmentItems": {          // Item.CreateAvatarItemsFromGSData (Common.AvatarSetup/Item.cs:63-110)
      "<Categories enum name: Back|Beard|Color|Cloth|Eye|Hair|Skin|BoardPieces|BoardTable|Collection|BoardTile|Species>":
        { "itemId": "ITEM_ID", "url3d": "bundle/url", "colorId": "COLOR_ID" }  // entry skipped if itemId empty or url3d empty
    },
    // stats / achievements (optional, profile screen)
    "achievementsProgress": { "ACH_ID": { "progress": 3 } },     // Common.Net/Achievement.cs:30
    "statistics": {                                              // Common.Net.PlayerStatistics/Statistics.cs:50
      "mostPlayedExpansions": [ { "keys": {"EXPANSION":"CatanBaseGame"}, "COUNT-WON": 5 } ],
      "mostPlayedMaps":       [ { "keys": {"MAP":"..."},                "COUNT-WON": 5 } ],
      "gamesWon":             [ { "keys": {"EXPANSION":"..","SINGLEPLAYER":0|1}, "SUM-COUNT": 5 } ]
    }
  }
}
```
Not in `PlayerDetails` (despite brief): no "tos accepted" bool exists - TOS state = `lastSeenTOS/AGB` only. Balance = `currency1` (gold/coins) + `currency2` (tickets); `ACCOUNT_GET_BALANCE` is dead. No `ownedExpansionsList`; expansions are the bitmask. Locally cached by client in `AuthenticationDetails` (Common.Net/AuthenticationDetails.cs) - server need not care.

### 1.2 Other-player profile (`ACCOUNT_GET_DETAILS_BY_ID`, friend/guild/leaderboard lists, matchmaking)

`PlayerDetails.Create(GSData)` (Common.Net/PlayerDetails.cs:222-253): flat object, same inner keys as 1.1 `scriptData` plus:
- `displayName` (string), identity = `userId` (string; if value null, tries `userId` as list) **else** `id`.
- `online` / `ingame` bool (top-level or inner), `isAi`, `difficulty`, `hidden` (AI only).
- `currency1/2` only if present. `guildName`, `level`, `xpForThisLevel`, `elo`, `sex`, `equipmentItems`, `skincolor`, `eyecolor`, `achievementsProgress`, `statistics`, `suns` as 1.1.
- If entry has nested `scriptData`, that object is parsed instead (so entries may be either flat or `{id,displayName,scriptData:{...}}`).

## 2. Per-id entries

### ACCOUNT_*

### ACCOUNT_LOGIN
kind: LogEvent · **login-critical** (any error aborts login)
req: `{APP_VERSION:number, PLATFORM:string, LANGUAGE:string, AUTHENTICATION_TYPE:"Device|Credentials|Migration", VERSION_NAME:string}`
resp: none read (only `error`). PROD answers with the own PlayerDetails in scriptData (AccountDetails.scriptData minus almanacVersion/aiPlayerVersion/tournament flags/virtualGoodsVersions; fresh account: level 1, karma 3, suns {permanent:1,temporary:0}, virtualGoods = BOARD_*_BASE, COLLECTION_BASE1, ITEM_MALE_HAIR1, `elo:{}`, `expansions:0`, `playercolor:1`, `online:true`, `ingame:false`).
errors client reacts to (NetworkResponseBase.cs:20-44): `100 ClientVersionTooOld`, `101 AdminModeActive`, `102 MaintainanceModeActive` (-> logout + maintenance screen), `103 PlayerIsBlocked`, `107 PlayerIsTemporarilyBlocked`, `53 LoginCacheCleared`, `104 EmailNotVerified`, `8 AccountDoesntExist` (=possible migration), `11/50 TimeOut`.
src: NS:324, Common.Net/AuthenticationBase.cs:94
notes: this is where server decides maintenance/version gating after auth. Auth itself (device/email/custom, session vars) is a separate doc.

### ACCOUNT_GET_DETAILS_BY_ID
kind: LogEvent · req: `{PLAYER_ID:string}` · resp scriptData: profile per 1.2 (flat, with `displayName` + `userId|id`).
push: - · src: NS:536; callers GameHub.States/ShowLeaderboardsState.cs:327, UiRework/ProfileScreen.cs:94, Common.AvatarSetup/AvatarContentController.cs:74 (own id, after equip), PlayerStatisticsState.cs:77
notes: **menu-critical**: avatar equip refresh calls it with own id. Not found -> return error `38 PlayerNotFound`.

### ACCOUNT_USE_SUN
kind: LogEvent · req: `{GAME_INFO:object (GameInformation.ToGSData; ignorable)}` · resp: `scriptData.suns {permanent,temporary,reloadTimes[]}` (same as 1.1). Error `407 NoSunsAvailable`.
src: NS:904; UiRework.ModeSelection/PlayGame.cs:112, GameHub.States/BaseSingleplayerOptionsState.cs:433, RivalsSinglePlayerState.cs:100
notes: only called when local player lacks the expansion bit (PlayGame.cs:107). With full `expansions` mask it is never sent. If `success` is false the singleplayer game does not start.

### ACCOUNT_EMAIL_VERIFY / ACCOUNT_RESEND_ACTIVATION_CODE
kind: LogEvent · req: `{code:string, email:string}` / `{email:string}` (lowercase keys!) · errors client knows: `105 ActivationCodeInvalid`, `106 ActivationCodeRequired`, `29 AccountAlreadyActivated`.
src: NS:368, NS:382; GameHub.States/RegisterStep2State.cs:51,71; Common.Net/Authentication.cs:233-310 (success -> NeedsEmailVerification=false); error -> hint `Error.Description`.
ours (no mail ever; env `CATAN_EMAIL_VERIFICATION=ingame|off`, default ingame): registration (`AuthenticateEmail` create -> `created`) writes server-only storage `email_verify/pending` {code: 5 random digits (client CODE_LENGTH 5)} (owner = user, perm 0/0). Marker present = unverified; absent (device, pre-feature accounts, off mode) = verified.
- both caller-only: non-empty `email` != caller's account email (case-insens.) -> `{errorCode:8}`, no code.
- RESEND resp: unverified -> `{code:"12345", delivery:"ingame"}` (same code until verified; mod shows it); else `{delivery:"auto"}`.
- VERIFY: unverified -> `""` = `106`, mismatch = `105`, match -> marker deleted, `{}`. Verified/off -> `{}` (any code).

### ACCOUNT_CHANGE_PASSWORD_REQUEST / ACCOUNT_CHANGE_PASSWORD
kind: LogEvent · req: `{EMAIL:string}` / `{EMAIL,CODE,PASSWORD}` · resp: none; errors `17 PasswordResetWrongCode`, `6 PasswordTooShort`, `8 AccountDoesntExist`.
src: NS:654, NS:673; Common.Net/NakamaConnector.cs:77, AuthenticationNone.cs:30 · notes: password-reset UI, runs on a TEMP device login (unauthenticated user).
ours: no mail -> REQUEST `{}` (no code, nothing revealed), CHANGE always `17`. Codes must never be returned in-game (anyone knowing an email could take over the account). Reset = operator via Nakama console (docs/HOSTING.md).

### ACCOUNT_DELETE_REQUEST
kind: LogEvent · req: `{}` · resp: none read (success -> client logs out; error -> silently ignored, no logout).
src: NS:1445; GameHub/PlayerMainScreen.cs:96, UiRework/AccountDeletionPopup.cs:31
notes: PROD marked accounts and later logins failed with `nakamaError:"account_marked_for_deletion"` (Common.Net/Error.cs:159 -> AccountDoesntExist). Ours deletes immediately (guild handed over/disbanded, lobbies left, leaderboard records, names, owned storage, then the Nakama account); token re-login (`create:false`) then fails with `User account not found.` (also AccountDoesntExist); a device login with create=true makes a fresh account.

### ACCOUNT_PLAYER_CONNECTED / ACCOUNT_PLAYER_DISCONNECTED (push, in-game)
see sec. 3.

### ACCOUNT_SET_COLOR, ACCOUNT_SET_SEX, ACCOUNT_SET_SKIN_COLOR, ACCOUNT_SET_EYE_COLOR
dead (NakamaSender wrappers at NS:561-613 have no caller; avatar edits go through `ITEM_EQUIP_ITEM`, NS:3831).

### ACCOUNT_GET_BALANCE, ACCOUNT_SET_BALANCE, ACCOUNT_GET_PAYMENTWALL_INFOS, ACCOUNT_UNLOCK_CLASSIC
dead (wrappers NS:3874, 3924, 629 have no caller; GET_BALANCE has no wrapper).

### FRIEND_* / friend lists

### ListGameFriendsRequest (standard GS, not an eventKey)
req: `{}` (RPC id `ListGameFriendsRequest`)
resp (**mixed levels**, NS:2316 + GetFriendsListFromResponse NS:2380-2409):
- top-level `friends: [PlayerDetails-flat]` (read from `BaseData`, NOT scriptData) = accepted friends.
- `playersRequestingFriendshipFromMe` / `playersIRequestedForFriendship`: read from `scriptData` if that key exists, else top-level. Safest: emit `scriptData:{both lists}` and `friends` top-level. Meaning: incoming requests / outgoing requests respectively.
- entry shape = sec 1.2 (`displayName`, `id|userId`, level, avatar, online...). A friend named `"Friends Migrating..."` is sorted first (GS migration leftover, ignore).
src: NS:2316, Common.Net.Friends/FriendsCollection.cs:116-122 (also called on every block/unblock)
notes: **menu-critical-ish** (called right after login; error => empty list, not fatal). Nakama: `nk.friendsList`: state 0=friends, 1=invite sent (->playersIRequestedForFriendship), 2=invite received (->playersRequestingFriendshipFromMe), 3=blocked (->BLACKLIST). Entries still need our profile data from storage.

### FRIEND_GET_ONLINE
kind: LogEvent · req: `{}` · resp: **top-level** (BaseData) `friendOnlineStatus:[{userId:string,online:bool}]` (NS:2299, Common.Net.Friends/FriendOnlineStatus.cs:12). Safe: also copy into scriptData. Error => ignored.
src: NS:2299, FriendsCollection.cs:121 · notes: Nakama presence/`nk.friendsList` user.online; client also uses socket follow/status (NakamaConnection.cs:899-920) - presence isn't required.

### FRIEND_FIND_PLAYER_BY_NAME
kind: LogEvent · req: `{DISPLAYNAME:string}` · resp scriptData: `players:[PlayerDetails-flat]` (missing key => treated as error path -> OnError). Empty match: `players:[]`.
src: NS:2342; GameHub.States/FriendsState.cs:359, UiRework/FriendSearchScreen.cs:48, GameHub.States/BaseCustomMatchState.cs:399 · notes: exact vs prefix search unknown (`?`); Nakama `users.getUsers` by username or storage index.

### FRIEND_REQUEST_FRIENDSHIP
kind: LogEvent · req: `{USER_ID:string}` · resp scriptData: optional `currplayer_friendlist_full:{curr:int,max:int}` or `recipient_friendlist_full:{curr,max}` (shows ticker, no friend added) else `{}` (client then marks I_REQUESTED). scriptData must exist.
push: to target `FRIEND_FRIENDSHIP_REQUESTED`
src: NS:2441, FriendsCollection.cs:150 · Nakama: `nk.friendsAdd`.

### FRIEND_ACCEPT_FRIENDSHIP / FRIEND_DECLINE_FRIENDSHIP
kind: LogEvent · req: `{USER_ID:string}` · resp: `{}` (decline also = cancel own request / unfriend, FriendsCollection.cs:156-163)
push: requester gets `FRIEND_FRIENDSHIP_ACCEPTED` / `FRIEND_FRIENDSHIP_DECLINED`
src: NS:2415, 2426 · Nakama: `friendsAdd` (accept) / `friendsDelete`.

### GET_BLOCKED_AND_FRIEND_IDS
kind: LogEvent · **matchmaking-critical** · req: `{}` · resp scriptData: `blocked:[userId]` (**always present**, may be empty), `friends:[userId]` (read only if gameInfo.FriendsOnly).
notes: `blocked` missing => `.Any()` on null throws => AddMatchmaker fails (Nakama.Core/NakamaInstance.cs:722-735). Result goes into matchmaker query/properties. Only when authenticated.
src: NS:1420, Nakama.Core/NakamaInstance.cs:718

### BLACKLIST_*
- BLACKLIST_GET_BLOCKED_PLAYERS: req `{}` · resp scriptData `blockedPlayers:[PlayerDetails-flat]` (missing key => logs error, returns empty list). Called at login (Common.PlayerAccount.Blacklist/BlacklistCollection.cs:26). src NS:1433.
- BLACKLIST_BLOCK_PLAYER: req `{PLAYER_ID}` · resp scriptData `blockedPlayers:[...]` (full new list) **or** `player_blocklist_full:{curr,max}` (ticker, nothing blocked). scriptData required. src NS:1460.
- BLACKLIST_UNBLOCK_PLAYER: req `{PLAYER_ID}` · resp scriptData `blockedPlayers:[...]`. src NS:1481.
- BLACKLIST_REPORT_PLAYER: req `{PLAYER_ID, CHALLENGE_ID ("-" if none), GAMELOG, GAMECHAT, DESCRIPTION, REASON:number (ReportReason: 0 ANTI_SOCIAL, 1 UNSPORTSMANLIKE)}` · resp ignored (fire & forget, durable). src NS:1507.
notes: Nakama friends state 3 = block (`nk.friendsBlock`) fits; need own storage for the list shown in UI (includes profile data). Official server evidently used groups `BLOCKED_<userId>` / `FRIENDS_<userId>` (dead helper code Nakama.Core/NakamaInstance.cs:1376-1432); not required for us.

### GUILD_*

Guild object (Common.Net/Guild.cs:57-71), always nested as `scriptData.guildData` unless noted:
```jsonc
"guildData": {
  "guildId": "gid", "guildName": "..", "guildDescription": "..", "guildMessageOfTheDay": "..",
  "ownerId": "uid", "ownerName": "..", "elo": 1000.0,
  "memberIds": ["uid"], "aspirantIds": ["uid"],     // MemberCount = memberIds.length ; both lists REQUIRED (null => ctor throws)
  // detail calls only (presence of members|aspirants triggers GuildDetails):
  "members": [PlayerDetails-flat], "aspirants": [PlayerDetails-flat], "owner": PlayerDetails-flat
}
```
Lists (`guilds:[guildObj]`) are NOT wrapped in guildData (each element is a guild object). `Guild.CreateFromGSData` returns null if `guildName` missing => "no guild".
Errors in guild calls (Error.cs:178-205): `scriptData.guildData.error` = `"GUILD_ALREADY_EXISTS"` (18), `"Already guild member"` (19), or `{teamType:"MAX_OWNED_REACHED"}` (19); plus enum codes 20,25-34,39,40,43,44,47 usable via `errorCode`. `scriptData.invalid_guild_name` (any value) on create => ticker "invalid name".
Nakama mapping: group = guild (name, description; MOTD + elo in group `metadata`; superadmin(0)=owner, admin(1), member(2), join-request(3)=aspirant; `open=false`). Nakama has no ELO/member-count sort or name-search paging with SKIP -> implement via group list + own sort. Client never calls Nakama group APIs for guilds (see sec. 5).

| id | req | resp scriptData | push | src |
|---|---|---|---|---|
| GUILD_GET_DETAILS | `{}` | `guildData` full (with members/aspirants/owner) or no `guildData` if not in a guild | - | NS:3298; Common.Net/GuildComponent.cs:174 (on guild screens/after changes) |
| GUILD_GET_DETAILS_BY_ID | `{GUILD_ID}` | `guildData` full | - | NS:3287 |
| GUILD_GET_GUILD_DETAILS_FOR_PLAYER | `{PLAYER_ID}` | `guildData` (light ok); no key/err => no guild | - | NS:3109; FriendsState.cs:230, BaseSeasonState.cs:380, TournamentDetailsState.cs:670. NOTE: on error client only logs, callback never fires |
| GUILD_CREATE | `{GUILD_NAME, GUILD_DESCRIPTION, GUILD_MESSAGE_OF_THE_DAY}` | `guildData` | - | NS:3201 |
| GUILD_SET_DESCRIPTION | `{DESCRIPTION, MESSAGE_OF_THE_DAY}` | `{}` | members: `GUILD_GMOTD_UPDATE` | NS:3235 |
| GUILD_JOIN_REQUEST | `{GUILD_ID}` | `{}` (success flag only) | owner: `GUILD_NEW_REQUEST` | NS:3249 |
| GUILD_ACCEPT_ASPIRANT | `{PLAYER_ID}` | `guildData` (updated, full) | applicant: `GUILD_REQUEST_ACCEPTED` | NS:3262 |
| GUILD_DECLINE_ASPIRANT | `{PLAYER_ID}` | `guildData` (updated) | applicant: `GUILD_REQUEST_NOT_ACCEPTED` | NS:3152 |
| GUILD_KICK_PLAYER | `{PLAYER_ID}` | `guildData` (updated) | kicked: `GUILD_GOT_KICKED`; others: `GUILD_REMOVED_PLAYER` | NS:3140 |
| GUILD_LEAVE | `{}` | `{}` | owner/members: `GUILD_REMOVED_PLAYER` | NS:3128 (owner cannot leave; client guards) |
| GUILD_CLOSE | `{}` | `{}` | members: `GUILD_CLOSED` | NS:3274 |
| GUILD_FIND_BY_NAME | `{GUILDNAME, SKIP:number}` | `guilds:[guildObj]` | - | NS:3164; GuildState/GuildList |
| GUILD_GET_MEMBER_SORTED_LIST | `{SKIP}` | `guilds:[guildObj]` (desc member count; page size `?`) | - | NS:3061; GameHub.States/GuildState.cs:368, UiRework/GuildList.cs:61 |
| GUILD_GET_ELO_SORTED_LIST | `{SKIP}` | dead (NS:3085 no caller) | | |
| GUILD_SET_ADMIN_PLAYER, GUILD_REMOVE_ADMIN_PLAYER | | dead (no wrapper at all) | | |

Guild chat: `SendTeamChatMessageRequest` with `teamType:"GUILD"`, `teamId:<guildId>` (NS:3337) -> see Chat. Guild Nakama group channel could back it.
**menu-critical?** Not blocking: guild screens only. `scriptData.guildName` in AccountDetails drives `IsInGuild`.

### MAIL_* and standard messaging

Mail = friend-to-friend messages, inbox UI. Message wire format: `message` field is a JSON **string** `{"subject":..,"message":..,"date":<long>}` (Common.Net.MailSystem/Mail.cs:41-89); if not parseable, whole string = body.

### MAIL_GET_LATEST_MAILS
kind: LogEvent · req: `{INDEX:number}` (last index client has; 0 initially) · resp scriptData: `lastIndex:int` (new high-water mark), `messages:[{messageId, fromId, playerId (recipient id), who (sender display name), message (JSON string above), alreadyRead:bool}]`. Messages with `fromId == own id` shown as OUTGOING.
src: NS:831, Common.Net.MailSystem/MailsCollectionComponent.cs:29,150 · called at login (non-fatal; empty ok: `{lastIndex:0,messages:[]}`)
notes: Nakama: storage collection `mail` (owner = recipient, auto-increment index per user) fits; or notifications.

### MAIL_READ_MAIL / MAIL_REMOVE_MAIL
req: `{MESSAGE_ID}` · resp ignored unless error. src: NS:815, 888; MailsCollectionComponent.cs:110, 55. `messageId` of locally-created outgoing mails is `outgoing_<ts>` (client-only; server may get remove for it).

### SendFriendMessageRequest (standard GS; sending mail)
req: `{friendIds:[userId], message:<JSON string>}` · resp ignored unless error. src: NS:871, MailsCollectionComponent.cs:90
push: each recipient gets `FriendMessage` (top-level fields `messageId, fromId, who, message, notification:bool, title, summary, subTitle`; parsed with same `Mail.CreateFromGSData` so also needs `playerId`, `alreadyRead`) -> NakamaListener.cs:556. Persist it in `mail` storage too.

### ListMessageRequest / DismissMessageRequest
dead on client (only GameSparksTestUI.cs / TestLogin.cs reference them; no gameplay caller).

### CHAT_GET_PLAYER_ID
kind: LogEvent · req: `{PLAYER_NAME}` · resp scriptData: `playerId`, `displayName`, `isOnline:bool`; if not found: return error or empty strings (client treats `playerId==""` as unknown).
src: NS:3663; Common.Screens.Chat/ChatController.cs:64, GameHub.Screens/BasePlayerEntry.cs:208

### CHAT_SEND_TO_PLAYER_ID (whisper)
kind: LogEvent · req: `{PLAYER_ID, MESSAGE}` · resp ignored (OnDefaultResponse: only error logged)
push: recipient gets `TeamChatMessage` with `teamType:"PLAYER_CHAT"`, `fromId`, `who`, `message`, `teamId`(`?` sender or recipient id; ChatMessage.id = teamId, Common.Screens.Chat/ChatMessage.cs:21-28). Whether sender gets an echo: `?` (ChatWhisper.cs:39 sends, listens on TeamMessageReceived).
src: NS:3710, Common.Screens.Chat/ChatWhisper.cs:39

### SendTeamChatMessageRequest (standard GS)
req: `{teamType: GUILD|LOBBY|TOURNAMENT|PLAYER_CHAT|GAMECHAT|SYSTEM (Common.Screens.Chat/Chat*.cs TeamType), teamId?, ownerId?, message}` · resp ignored (lobby/tournament: error => "chat doesn't exist" callback).
push: members get `TeamChatMessage` {`chatMessageId,fromId,who,message,teamId,teamType,ownerId`} (GameSparks.Api.Messages/TeamChatMessage.cs).
src: NS:3337 (guild), 3643 (lobby/tournament), 3700 (unused teamType-only). In-game chat uses the Nakama channel (channel id = match id), not this.

### TERMS_*

### TERMS_GET_TOS / TERMS_GET_AGB
kind: LogEvent · **login-critical** (on error client only logs and the post-login chain never continues -> login hangs)
req: `{LANGUAGE:string}` · resp scriptData: TOS: `{TOS:string html/text, tosDate:ISO-8601 string, PROD "2017-11-30T09:12:03.135Z"}`; AGB: `{AGB:string, agbDate:ISO string}`.
notes: result is NOT used to show anything (`UpdateTOSAndAGB` callback ignores flags, Common.Net/Authentication.cs:390-418); only needs to succeed with `scriptData` present.
src: NS:693, 713; TOSResponse.cs

### TERMS_ACCEPT_TOS / TERMS_ACCEPT_AGB
dead in practice (`Authentication.MarkTOSSeen/MarkAGBSeen`, Authentication.cs:420-427, have no caller). Implement as `{}` no-op.

### PUSH_NOTIFICATIONS_* and PushRegistrationRequest
- PUSH_NOTIFICATIONS_GET_OPTIONS: effectively dead on desktop (sole caller `PushNotificationsOptionsUpdater.OnAuthenticationChanged` is never subscribed; Common.Net/PushNotificationsOptionsUpdater.cs:7-24). If wanted: resp scriptData `{news,events,social: bool}`.
- PUSH_NOTIFICATIONS_SET_OPTIONS: dead (NS:779 no caller). req would be `{NEWS,SOCIAL,EVENTS: 0|1}`.
- PUSH_NOTIFICATIONS_UNREGISTER: req `{REGISTRATION_ID}`, only when a stored pushRegistrationId exists (mobile only) -> no-op `{}`. src NS:803, Common.Net/PushNotifications.cs:60
- PushRegistrationRequest: req `{deviceOS:"ios", pushId}`; resp top-level `registrationId:string` (PushRegistrationResponse.cs:7). Skipped on desktop (`!GameRoot.IsDesktop()`, PushNotifications.cs:46). src NS:792. no-op `{registrationId:"x"}`.

### SERVERNEWS_*
- SERVERNEWS_GET: kind LogEvent · req `{LANGUAGE}` · resp scriptData `news:{title, content, linkURL, imageUrl, seenByPlayer:bool, lastUpdated:"Thu Jan 01 2026 00:00:00 GMT+0000 (UTC)"}`. Missing `news` => treated as seen => nothing shown. Main menu only, non-fatal.
  src NS:352, ServerNewsResponse.cs:23-50; GameHub.States/MainState.cs:130, UiRework/MessageScreen.cs:61,167
- SERVERNEWS_MARK_SEEN: req `{}` · resp `{}`. src NS:252; MainState.cs:150,157, ShowWelcomeScreenState.cs:54

### META_TUTORIAL_* (new-player onboarding overlay)
- Semantics (MetaTutorialController.cs:200-215): the client re-sends `META_TUTORIAL_STARTED{TUTORIAL_ID}` for every step in its local progress that the server lacks -> STARTED = "step done": server sets `currentStep=id` and appends to `stepsCompleted`.
- META_TUTORIAL_GET_PROGRESS: req `{}` · resp scriptData `currentStep:string`, `stepsCompleted:[string]` (both read; **scriptData required**). Called on AuthenticationChanged (Common.Metatutorial/MetaTutorialController.cs:318). Empty `currentStep` => starts at first tutorial. Step ids are authored in Unity assets (not in decomp) -> `?`; to skip the tutorial the last step id must be known (capture from a real client's META_TUTORIAL_STARTED calls).
- META_TUTORIAL_STARTED: req `{TUTORIAL_ID}` · resp ignored. src NS:4399; MetaTutorialController.cs:197,240
- META_TUTORIAL_RESET: req `{}` · resp same as GET_PROGRESS. src NS:4411; MetaTutorialController.cs:97 (settings "reset")
src (GET): NS:4387. Display-name entry for new accounts goes through `ChangeUserDetailsRequest` (MetaTutorialNamePlayerState.cs:75).

### TUTORIAL_* (in-game tutorials)
- TUTORIAL_GET_PROGRESS: req `{EXPANSIONS:{keys:[CatanBaseGame,CatanCitiesAndKnights,CatanSeafarer,RivalsBaseGame,CatanRiseOfTheInkas]}}` · resp scriptData `tutorialPlayedList:{<ExpansionName>:[0|1,...per chapter]}`; missing key/exp => nothing marked. Called at login (Common.Tutorials/TriggeredTutorials.cs:38). Non-fatal. src NS:4348
- TUTORIAL_FINISH_CHAPTER: req `{CHAPTER_ID:int, EXPANSION_ID:string, CHAPTER_COUNT:int}` · resp scriptData `chaptersPlayedCount:int`, `xpEarned:int`; if `bonusReceived` key present client ignores reward. src NS:4312; Common.Tutorials/Tutorial.cs:122, RivalsTutorial.cs:96. Reward (xp/coins) side effects: server's call.

### ALMANAC_*
- Local source: `StreamingAssets/Almanac` = base64 thrift-binary `Almanac` (English `en`, version 97, 22 categories/278 entries), loaded at start and copied to `persistentDataPath/Almanac` (CommonCatanSerializer.cs:163-200); the saved copy is shared by official and custom servers. `tools/gen-almanac.py` converts the host's own copy to `server/data/almanac.json` (optional, gitignored: USM text).
- Download rule (NakamaSender.cs:458-470 after AccountDetails, also AlmanacController.cs:27-47): ALMANAC_GET_DATA only if `almanacVersion` (AccountDetails/GET_VERSION) > local version, or local language != UI language, or `almanacVersion` missing. `OnAlmanacDownloaded` (AlmanacController.cs:58) replaces + SAVES whatever arrives; an error or null scriptData becomes an empty almanac with version 1 (NS:494-509) = wipes the saved one.
- ALMANAC_GET_VERSION: req `{}` · resp scriptData `almanacVersion:int` (default 1). src NS:515; Common.PlayerAccount.Almanac/AlmanacController.cs:35
- ALMANAC_GET_DATA: req `{LANGUAGE}` (UI language name, e.g. `en`) · resp scriptData `almanacVersion:int`, `almanac:[{category:string, sortEntries:bool, gameTypes?:[Catan|..] (default Catan), entries:[{id, headline, content}]}]`. Missing `almanac` => `GetGSDataList` null => NRE in Category.cs:30 before `onDone`, caught + logged by PlatformBase.Update (and reported via ERROR_REPORT_EXCEPTION): nothing is saved. src NS:491; Category.cs:25-58, Entry.cs:21. Called at login (non-fatal).
- Server (content.ts): without `almanac.json` `almanacVersion` = 0 (never newer than the local copy) and GET_DATA answers `{almanacVersion:0}` without a list; same for a LANGUAGE other than the file's `language`. So English clients never download, other languages try once per login and keep their own almanac (bundled English, or their language from the official servers) instead of an empty or English one. With the file and a matching language it is served as is.

### ERROR_*
- ERROR_REPORT_EXCEPTION: req `{CHALLENGE_ID, CALLSTACK, TYPE, CONDITION, PLATFORM, VERSION}` · resp ignored. Fired for every client exception log, durable. Just `{}` (or log). src NS:164; UnityGameBase.Core.Log/IngameLog.cs:66, Common.Net/ErrorReporter.cs:74
- ERROR_AI_CRASH: dead as a GS event (NS:200 `SendAiCrash` goes to GameAnalytics only).

### TEST_* , MAINTAINANCE_* , MAINTENANCE_*
TEST_EXECUTE, TEST_PLAYGROUND_EVENT, MAINTAINANCE_TESTCALL, MAINTAINANCE_TESTCALL2, MAINTENANCE_CHECK_INDICES, MAINTENANCE_CLEAR_CACHE, MAINTENANCE_REMOVE_PROMOS: dead (no caller; server admin tools).

### Standard GS requests

### AccountDetailsRequest
req `{}`; resp sec 1.1. **login-critical**. src NS:423; Common.Net/LocalPlayer.cs:112 (refresh on LEVEL_PROGRESS etc.).

### ChangeUserDetailsRequest
req `{displayName, (userName,language,newPassword,oldPassword unused)}`; resp: none read; errors `10 PlayerNameAlreadyExists` (or legacy `{displayName:"already set"}`). Client then re-fetches AccountDetails. src NS:406; MetaTutorialNamePlayerState.cs:75, UiRework/ChangeNamePopup.cs:52. **needed for first-run name entry.** Nakama: `nk.accountUpdateId` (display_name) + uniqueness index.

### ListGameFriendsRequest, SendFriendMessageRequest, SendTeamChatMessageRequest, PushRegistrationRequest
see FRIEND/MAIL/CHAT/PUSH sections.

### EndSessionRequest
req `{}`; fired on explicit disconnect/shutdown (Nakama.Core/NakamaInstance.cs:404, GameSparks.Core/GSInstance.cs:309). resp ignored; handle as no-op / mark offline.

### ListMessageRequest, DismissMessageRequest
dead (only GameSparksTestUI.cs, TestLogin.cs).

## 3. Pushes (server -> client) in scope

All via Nakama notification (persistent) with GS JSON content (sec 0). `data` = `ScriptMessage.Data` (`response.GetObject("data")`, GameSparks.Api.Messages/ScriptMessage.cs:10).

| extCode / class | data fields read | client action | src |
|---|---|---|---|
| FRIEND_FRIENDSHIP_REQUESTED | PlayerDetails-flat of requester (`displayName`,`id|userId`,...) | adds as REQUESTING_FRIENDSHIP_FROM_ME | NakamaListener.cs:567 |
| FRIEND_FRIENDSHIP_ACCEPTED | PlayerDetails-flat of acceptor | adds friend | NakamaListener.cs:589 |
| FRIEND_FRIENDSHIP_DECLINED | PlayerDetails-flat | removes request | NakamaListener.cs:578 |
| FriendMessage (class) | see MAIL | mail inbox | NakamaListener.cs:556 |
| TeamChatMessage (class) | see Chat | chat | NakamaListener.cs:538 |
| GUILD_NEW_REQUEST | guildObj (top-level of `data`, NOT wrapped in guildData; needs `guildName` or ignored) | owner sees incoming request | NakamaListener.cs:459 |
| GUILD_REQUEST_ACCEPTED | guildObj | local guild set | :479 |
| GUILD_REQUEST_NOT_ACCEPTED | guildObj | clears aspirant | :469 |
| GUILD_GOT_KICKED | guildObj | local guild removed | :498 |
| GUILD_REMOVED_PLAYER | guildObj (updated) | member list update | :508 |
| GUILD_CLOSED | - | local guild removed | :489 |
| GUILD_GMOTD_UPDATE | `message:string` | MOTD update | :527 |
| ACCOUNT_PLAYCATAN_BONUS_UNLOCKED | `coins:int`, `tickets:int` | popup (legacy Catan Classic bonus) | NakamaListener.cs:887 |
| ACCOUNT_SHOW_RATING_REMINDER | - | mobile rating prompt | :878 (RatingReminder is mobile-only) |
| ACCOUNT_PLAYER_CONNECTED / _DISCONNECTED | `playerId:string`, (disconnect: optional `hostIdx:int`) | in-game player frame online state; only matters in a running match | :855-876 |
| LEVEL_PROGRESS | `level:int` (default 1), `tickets:int` | refreshes AccountDetails + toast | :265, Common.Net/LevelProgressHandler.cs:16 |
| SYS_MAINTENANCE | none | `TriggerMaintenance()` -> **terminates session** and shows maintenance | NakamaListener.cs:260, Common.Net/Authentication.cs:436 |
| PUSH_NOTIFICATION | - | dead (no dispatcher case, NakamaInstance.cs:576-698) | |
| SessionTerminatedMessage / subject `single_socket` | - | forced logout (kicked by another login) | NakamaConnection.cs:595,634 |
| AchievementEarnedMessage | achievement fields (not in scope) | | |

## 4. ErrorCode values worth emitting (`error.errorCode`)

1 Unknown, 3 AccountDoesntExistOrWrongPassword, 4 AccountNameAlreadyExists, 6/7 Password too short/long, 8 AccountDoesntExist, 10 PlayerNameAlreadyExists, 11 TimeOut, 17 PasswordResetWrongCode, 18 GuildNameAlreadyExists, 19 AlreadyGuildMember, 20 AlreadyGuildOwner, 25/26 GuildNameTooShort/Long, 27 NotLoggedIn, 29 AccountAlreadyActivated, 31 GuildNoAdminRights, 32 GuildDoesNotExist, 33 GuildNameInvalid, 37 AgbAndTosNotRead, 38 PlayerNotFound, 43/44 GuildMembershipLevelTooLow/GuildCreationLevelTooLow, 47 GuildMaxMembersReached, 48 FeatureCurrentlyNotAvailable, 53 LoginCacheCleared, 100 ClientVersionTooOld, 101 AdminModeActive, 102 MaintainanceModeActive, 103 PlayerIsBlocked, 104 EmailNotVerified, 105/106 Activation code, 107 PlayerIsTemporarilyBlocked, 407 NoSunsAvailable, 700 NakamaError. Full enum: Common.Net/ErrorCode.cs.

## 5. Nakama built-in mapping + the "direct" group calls

- `NakamaConnection.GetGroupUsers` / `GetUserGroups` (ListGroupUsersAsync / ListUserGroupsAsync, NakamaConnection.cs:948-973) **have no callers anywhere in the decomp**; the helpers that would use them (`GetBlockedUserGroupId`, `GetBlockedUsersIdList`, `GetFriendsUserGroupId`, NakamaInstance.cs:1376-1432) are private and unused, and `NakamaQueryConfig.AddFriendsUsersIds` (:444) is unused. Matchmaking gets blocked/friends via the `GET_BLOCKED_AND_FRIEND_IDS` RPC instead. => No need to expose guild groups with specific naming. (Official backend apparently modelled blocked/friends as groups `BLOCKED_<uid>`/`FRIENDS_<uid>`.)
- Client uses of Nakama built-ins directly: socket presence follow/unfollow (NakamaConnection.cs:899-945), notifications list/delete (:570-630), matchmaker/match/chat (other docs). Everything else is RPC.
- Suggested server backing: friends -> `nk.friends*` (+RPC shaping profile data); blocks -> friend state 3 or storage; guilds -> `nk.group*` (+storage for elo/MOTD, own sort/search); mail -> storage `mail` + notifications; profile -> storage `profile` (version-controlled doc) + account display_name/metadata; terms/news/almanac -> static config in module.

## 6. Criticality summary

- **Blocks login if missing/wrong**: ACCOUNT_LOGIN, AccountDetailsRequest (needs `userId`,`currency1`,`currency2`, `scriptData.authenticationType`), TERMS_GET_TOS, TERMS_GET_AGB (+ ITEM_GET_PRODUCT_ITEMS, outside this doc).
- **Breaks main menu / first run**: ChangeUserDetailsRequest (name entry), META_TUTORIAL_GET_PROGRESS (scriptData required), ACCOUNT_GET_DETAILS_BY_ID (own profile refresh after equip), ALMANAC_GET_DATA (needs `almanac`), ListGameFriendsRequest / BLACKLIST_GET_BLOCKED_PLAYERS / MAIL_GET_LATEST_MAILS / TUTORIAL_GET_PROGRESS / SERVERNEWS_GET (non-fatal if error, wrong shape can NRE).
- **Breaks matchmaking**: GET_BLOCKED_AND_FRIEND_IDS (`blocked` list must exist).
- Everything else is feature-local (guild, mail send, whisper, report).
