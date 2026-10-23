# Economy / Ranking / Progression contracts

Scope: SHOP_*, PAYMENT_*, ITEM_*, ACCOUNT_{GET_BALANCE,SET_BALANCE,USE_SUN,UNLOCK_CLASSIC}, TICKET_UNLOCK_EXPANSION, EXPANSION_*, PROMOTION_*, ACHIEVEMENTS_INCREASE, LEADERBOARD_*, SEASON_*, TOURNAMENT_*, standard GS requests, related pushes.
Decomp paths relative to `$HOME/Documents/Decomps/Catan`. `NS` = `Common.Net/NakamaSender.cs` (line = the `new LogEventRequest_X()` line = start of the wrapper).

## 0. Transport recap (what matters here)
- Every `LogEventRequest_<KEY>` -> RPC id `<KEY>` (`Nakama.Core/NakamaConnection.cs:328,499`), payload = GS request JSON (fields below, UPPER_CASE names), response payload = GS `LogEventResponse` JSON; the client reads **only `scriptData`** (plus `error`).
- Standard (non-LogEvent) requests have no `eventKey` -> RPC id = request type name: `LeaderboardDataRequest`, `LeaderboardsEntriesRequest`, `GetLeaderboardEntriesRequest`, `AccountDetailsRequest`, etc. Their response is the matching typed response (`LeaderboardDataResponse` ...), **not** scriptData-wrapped (see section 3).
- `LogChallengeEventRequest_*` classes: **all dead** (never instantiated anywhere). Only `LogEventRequest_*` are used.
- Requests marked `SetDurable(true)` are queued/resent by the client (`NS`), so handlers should be idempotent.
- Pushes: Nakama notification, content = GS message JSON. Dispatch table is `Nakama.Core/NakamaInstance.cs:547-700` (`messageClass` + `extCode`). **Anything not in that switch is silently dropped.**

## 1. Content the server must serve

| Content | Fetched via | Parsed at | Bundled client-side? | Notes |
|---|---|---|---|---|
| Shop categories (list of enum names) | `SHOP_GET_CATEGORIES` | `Common.Shop/ProductCategory.cs:29` | PROD sends `[Coins, Expansion, AvatarCollection, Bundle, BoardTable, BoardPieces, BoardTile]` | cached in-memory + `ShopContentSerializer` disk cache, re-fetched per login if empty (`ShopContentController.cs:57`) |
| Shop products per category | `SHOP_PRODUCTS_FOR_CATEGORIES` | `Common.Shop/Product.cs:112` | no | re-fetched every 10 min / on forceReload (`ShopContentController.cs:~140`). Icons/images via `assetbundlePath` -> CDN bundle |
| Avatar items + colors + board pieces/tables/tiles | `ITEM_GET_PRODUCT_ITEMS` | `Common.AvatarSetup/Item.cs:118`, `ItemColor.cs:46`, `NS:3728-3790` | no | **Item defs carry `url3d`/`url2d` = asset-bundle names resolved against CDN `bundleURL`** (see below). Cached via `AvatarItemsDictSerializer`; refetched when `NextUpdate` passed or on LEVEL_PROGRESS push (`AvatarContentController.cs:26,98`) |
| Expansion marketing hints | `EXPANSION_COMMERCIAL_GET_HINTS` | `ExpansionCommercialController.cs:48` | no (optional) | PROD: `{ExpansionHints:{<Expansion>:{entries:[str]}}}` (10 expansions; `_EOB` is `{}`); ours: same keys, own text (`data/prod.json`) |
| Promotions | `PROMOTION_GET_PLAYERS_PROMOTIONS` | `Common.Promotion/Promotion.cs:40` | no (optional) | empty lists ok |
| Seasons | `SEASON_GET_SEASONS_DETAILS` | `Common.Net/Season.cs:55` | no (optional) | `{"seasons":[]}` = no season UI |
| Tournament config | `TOURNAMENT_GET_CONFIG` | `Common.Net/TournamentConfigData.cs:74` (Unity `JsonUtility`) | defaults hardcoded in class | `isFeatureEnabled` default false -> tournament button disabled (`GameHub.Screens/PlayModeScreen.cs:93-97`) |
| Leaderboard brackets (% thresholds) | `LEADERBOARD_GET_BRACKETS(_BY_ID)` | `GameHub.States/LeaderboardBrackets.cs:90` | no | 5 ints; absent => all 0 => everybody rank class 5 |
| Level -> XP table | none | `Common.Net/LevelProgress.cs:11` | **hardcoded**, max level 25 | server must award XP consistent with this table (0,100,250,400,550,850,1200,...,10000) |
| Level reward definitions (icons, texts) | none | `Common.Net/LevelProgressRewardDefinition.cs`, `GameHub.Screens/LevelProgressScreen.cs` | **ScriptableObjects in client** | server only sends level + tickets |
| Scenarios / game modes / expansions list | none | `GamemodeData.cs`, `ScenarioData.cs`, `ExpansionsList.cs` | **ScriptableObjects in client** | server never lists scenarios; only the ownership bitmask matters |
| Achievements: ids, max progress | none | `Common.Net/AchievementId.cs`, `Common.Unity/AchievementValuesMapping.cs` | **client** (enum 21 ids, max in scene component) | server only stores progress; `Enum.Parse` on unknown id throws (`EarnedAchievement.cs:12`) |
| Almanac | `ALMANAC_GET_DATA/VERSION` (ACCOUNT agent) | `Common.PlayerAccount.Almanac/*` | local cache | out of scope here |
| AI player details | `NS:~448` (ACCOUNT agent) | - | - | out of scope |

### Asset bundle CDN (critical for items/shop images)
- Bundle root = `CommandLineController.AssetBundleURL` (`Common/CommandLineController.cs:24,95,113`): default `https://cdn.catancdn.de/nk/nk-prod/bundle/`, overridable by CLI arg `bundleURL=`; actual load URL = `{bundleURL}{BuildID}/{Windows|...}/` (`Common.AssetBundles/CatanAssetLoader.cs:18`).
- Item `url3d` is passed to `Loader.LoadBundle(url3d, assetName=basename-without-ext)` (`Common.Unity.AvatarSetup/DisplayedItem.cs:56`, `GameHub/BoardPiecesPreview.cs:81`) -> it is a **bundle name relative to that root**, not a URL. Server item defs must reference bundle names that exist on the CDN (or a mirror served via `bundleURL=`).
- `RewardItem.Url2Dsprite` is read from `itemDef.url3d` too (`Common.Net/RewardItem.cs:33`).
- Unknown: whether the official CDN is still alive; real item ids/bundle names must be captured (no catalog data in decomp).

## 2. Ownership / entitlements model

All entitlement state reaches the client through **account details** (not through the shop):
- `AccountDetailsRequest` (standard) response -> `PlayerDetails.CreateFromAccountDetails` (`Common.Net/PlayerDetails.cs:~283`), and `ACCOUNT_GET_DETAILS_BY_ID` -> same parser `GetPlayerDataFromGSData` (`PlayerDetails.cs:300-407`). Parser reads from `scriptData` if present, else top-level.
- Re-pulled after: purchase, ticket unlock, level progress, steam finalize (`LocalPlayer.UpdateDetailsFromServer`, `Common.Net/LocalPlayer.cs:100`).

| Field (in `scriptData` unless noted) | Type | Effect | Value for "everything unlocked" |
|---|---|---|---|
| `expansions` | long bitmask (`ExpansionsEnum` values) | `HasExpansion()` (`PlayerDetails.cs:575`) gates scenarios (`UiRework/ScenarioCardManager.cs:247,316`, `UiRework.ModeSelection/PlayGame.cs:106`), multiplayer lobby (all players must own selected expansions: `PlayGame.cs:373`), leaderboards, shop "AlreadyBought" mirror | **131071** (0x1FFFF = bits 0x1..0x10000). Bits: 1 CatanBaseGame, 2 Seafarer, 4 CitiesAndKnights, 8 RivalsBaseGame, 0x10 RivalsAgeOfDarkness, 0x20 RivalsAgeOfEnlightenment, 0x40 ArrivalAtCatan, 0x80 RiseOfTheInkas, 0x100 AoE_EOE, 0x200 Explorers, 0x400 AoD_EOB, 0x800 BigGame, 0x1000.. season pseudo-expansions |
| `expansionsViaPromoFlag` | long bitmask | `HasExpansionViaPromotion`; `OwnsExpansion()` is false for promo-only (`PlayerDetails.cs:566`) | omit or 0 (so `OwnsExpansion` stays true) |
| `virtualGoods` | object, **keys** = owned item/product ids | `OwnedItemIds` (`PlayerDetails.cs:309`) -> avatar item ownership (`Item.IsOwnedByLocalPlayer`, `Common.AvatarSetup/Item.cs:225`), `IsPaidUser()` (`PlayerDetails.cs:655`: needs a key equal to an `ExpansionsEnum` name, e.g. CatanBaseGame/CatanSeafarer/CatanCitiesAndKnights/RivalsBaseGame/CatanExplorers/CatanRiseOfTheInkas/RivalsAgeOfEnlightenment_EOE/RivalsAgeOfDarkness_EOB), shop offers filter (`OfferNewOrDiscountInfo.cs:17`) | `{CatanBaseGame:1, CatanSeafarer:1, ..., <every item id from ITEM_GET_PRODUCT_ITEMS>:1}` |
| `currency1` (also top-level of AccountDetails response) | int | Gold/coins (`GoldAmount`) | e.g. 99999 |
| `currency2` | int | Tickets/"scrolls" (`TicketsAmount`) used for season join + `TICKET_UNLOCK_EXPANSION` | e.g. 999 |
| `suns` `{permanent:int, temporary:int, reloadTimes:[ISO]}` | | free-play "sun" system: playing a non-owned scenario in singleplayer needs a sun (`ScenarioCardManager.cs:248`). `HasSunAvailable = temporary>0 || permanent-len(reloadTimes)>0` (`SunSystem.cs:30`). If `suns` absent -> `SunSystem==null` -> HasSuns false | irrelevant when `expansions` is full; still send `{permanent:2,temporary:99,reloadTimes:[]}` so UI does not show broken sun widgets (`SunSystemController.cs:57`) |
| `scrollsEnabled` | bool | tickets UI | true |
| `canCreateTournament`(default true), `canCreateTournament_beta`, `canCreateFreeTournament`, `xpBoost`(float,def 1), `level`,`xpForThisLevel`,`xpFromThisLevelToNext`,`karma`(def 3),`elo{<Exp>:float}`,`eloPlacement{<Exp>:int}`,`achievementsProgress{<id>:{progress}}`, `guildName`,`authenticationType`,`appVersion` | | misc profile | see ACCOUNT spec |

Per-item lock flags (served by `ITEM_GET_PRODUCT_ITEMS`, not per player): `isLocked`(+`lockedReason`) at top-level of each item entry (`Item.cs:~143`) and `equipDef.isLocked` for colors (`ItemColor.cs:71`). `AvatarItemUIEntry.GetItemStatus` (`GameHub.Screens/AvatarItemUIEntry.cs:166`): Equipped > Owned (id in virtualGoods) > locked/purchasable. So: **item unlocked iff its id is a key in `virtualGoods`**; set `isLocked:false` on all defs too.
Shop product flags: `AlreadyBought` (hides price, shows owned icon), `IsPurchasable`, `ConditionText` (reason). Expansion product `ID == ExpansionsEnum.ToString()` (`ShopController.cs:269`). Set `AlreadyBought:true` for everything owned.
Fallbacks if item catalog is unknown: Harmony-patch `Item.IsOwnedByLocalPlayer` -> true and `Item.IsLocked` -> false.

Minimal "everything unlocked" account: `expansions=131071`, `virtualGoods` with expansion-name keys (+ all item ids), `currency1/2` high, `suns` present (server: only with the local-testing dev unlock, tools/README.md).

## 2a. Server entitlements (custom; `server/src/entitlements.ts`)
**Free official account (PROD capture, fresh guest):** `expansions:0`, `expansionsViaPromoFlag:0`, `currency1/2:0`, `suns:{permanent:1,temporary:0,reloadTimes:[]}`, `scrollsEnabled:false`, `virtualGoods` = 47 starter ids (base hair/beard/cloth, base board pieces/table/tile, `COLLECTION_BASE1`, 23 colors); no expansion-name keys (`IsPaidUser()` false).
What such an account can do (decomp):
- Online base game only via **Free Play** (free match): `ScenarioCardManager.cs:247` (`HasExpansion || IsFreeMatch`), `PlayGame.cs:373` (expansion check skipped for free match), `GameSelectScroller.cs:28` (multiplayer scrolls to the free-play box without base game), `ObjectFreeplayToggle.cs:21`. Auto (ranked) match of the base game: locked -> shop (`ScenarioCardManager.cs:249-252`, old UI `ExpansionState.cs:428`).
- Single player: needs a sun when the expansion is not owned (`PlayGame.cs:106`, `ScenarioCardManager.cs:286` `SunClicked` -> `ACCOUNT_USE_SUN`, `BoxButtonWrapper.cs:164`); `firstisland` without base game/sun is capped to 3 players (`CatanSingleplayerOptionsState.cs:45`). Tutorials: no check (`PlayGame.StartGameTutorial`).
- Custom lobby (registered users): base game without ownership = 3 players, easy AI, Arrival-at-Catan options (`CatanCustomMatchState.cs:20-80`, `Lobby.cs:219`).
- Chat in a not-owned expansion's game is limited (`ChatPanel.cs:149` `OwnsExpansion`).
- Level-locked catalog entries (`equipDef.isLocked` + `itemDef.lvlRequirement`, e.g. `ITEM_MALE_CLOTH2` 7, `COLOR_TURQUOISE` 23) are level rewards; the client never reads `lvlRequirement`, so the server grants them by level.

Server modes (`entMode`): `free` (default) = the above + level rewards for the player's level; `owned` = free + the player's claim; `dev` (local-testing unlock, tools/README.md) = everything. Computed per read (`entFor`) for own details, `ACCOUNT_GET_DETAILS_BY_ID` (lobby checks use other players' bitmasks), `ITEM_GET_PRODUCT_ITEMS`/`SHOP_PRODUCTS_FOR_CATEGORIES` (`AlreadyBought` = owned, `IsPurchasable:false`, `ConditionText` "Not available on this server."), `ITEM_EQUIP_ITEM` (not-owned items ignored). Outside dev: `SHOP_BUY_OFFER` and `TICKET_UNLOCK_EXPANSION` -> `{errorCode:48, customErrorMessage}`, `SHOP_GET_EXTERNAL_PRODUCTS`/`PAYMENT_GET_STEAM_PRODUCT_PRICE` empty. Wallet starts at 0 (profiles without `entV` are reset once: currency, suns). `ACCOUNT_USE_SUN`: temporary first, else a permanent sun -> `reloadTimes += now+24h` (official reload time unknown), none left -> error 48.

### COMMUNITAN_ENTITLEMENTS_CLAIM
kind: LogEvent (custom, mod `Entitlements.cs`; sent only when `COMMUNITAN_STATUS.entitlements == "owned"`) · req: `{expansions:long, items:[string], officialUserHash:hex64 (sha256 of the official userId), capturedAt:ISO}` · resp: `{expansions (masked), items (accepted count), rejected (unknown ids)}` · errors `code`: `ENTITLEMENTS_NOT_OWNED_MODE`, `ENTITLEMENTS_BAD_HASH|BAD_EXPANSIONS|BAD_ITEMS|BAD_CAPTURED_AT`, `ENTITLEMENTS_ALREADY_CLAIMED`
- `expansions & 0x1FFFF`; items kept iff in items.json/shop.json (items, colors, boards, collections, bundles); expansion-name items dropped (bitmask only); <= 1000 items. Collections/bundles grant their contents at read time (`itemDef.setCollection`, `BundleProducts`).
- Binding: `ent_bind/<hash>` (system user, create-only) -> first claiming account; other accounts get `ENTITLEMENTS_ALREADY_CLAIMED`. Re-claim by the owner replaces the stored claim. Account deletion frees the hash. Not tamper-proof (client-side data).
- Mod records the official side from every PROD `AccountDetailsResponse` (`scriptData.expansions`, `virtualGoods` keys, `userId` hash) into `BepInEx/config/Communitan.entitlements.json`; after a successful claim it re-requests account details and force-reloads the Expansion/Bundle/AvatarCollection shop categories.

## 3. Standard GS requests

| Request (RPC id) | req | resp fields client reads | src | status |
|---|---|---|---|---|
| `LeaderboardDataRequest` | `leaderboardShortCode`, `entryCount`, `offset`, `social`(bool), `dontErrorOnNotSocial`(bool); also settable but unused: friendIds, teamIds, teamTypes, includeFirst/Last, inverseSocial, challengeInstanceId | `data[]` = {`userId`,`userName`,`rank`, `<eloKey>`(float, elo*1e6), `<countKey>`(number), `HASFINISHED`(bool); guild: `teamId`,`teamName`}; plus `scriptData.entryCount`(int). Error code `LeaderboardDoesntExist` is tolerated (empty list) | `NS:3386,3441,3536,2003`; `Common/LeaderboardEntry.cs:50`; `Common.Net/Elo.cs:5` (factor 1e6, default elo 1000) | live |
| `LeaderboardsEntriesRequest` | `player`(id), `leaderboards`[shortcodes] | **top-level** key per shortcode: `{<shortCode>:[{score,gamesPlayed,rank,...}]}`; `scriptData.entryCount` | `NS:3415,3618`; `LeaderboardEntry.cs:109` | live |
| `GetLeaderboardEntriesRequest` | `leaderboards`["TOURNAMENT_AUTO"] | `scriptData.rank` (int, -1 default) | `NS:3601` (`SendGetTournamentsLeaderboard`) | wrapper has no caller -> dead |
| `ListVirtualGoodsRequest`, `ListAchievementsRequest`, `ListChallengeTypeRequest` | - | - | only `GameSparksTestUI.cs:134-188` | dead |
| `GetDownloadableRequest`, `GetUploadUrlRequest` | - | - | only `GameSparks.Api/GSHelper.cs:10,17` (helpers, no callers) | dead |

Leaderboard shortcodes used: `PLAYER_ELO_RANKING.EXPANSION.<ExpansionsEnum>` (elo key `ELO`, count key `INCREASE`; entries via LeaderboardData; own entry via LeaderboardsEntries with keys `score`/`gamesPlayed`), `GUILD_ELO_RANKING` (keys `LAST-ELO`/`SUM-COUNT`, dead caller), `TOURNAMENT_AUTO.TOURNAMENT_ID.<id>` (elo key `ELO`), `TOURNAMENT_CUSTOM.TOURNAMENT_ID.<id>` (`RANKED_VALUE`), both with count key `GAMES_PLAYED`. Social flag = friends-only filter.
Elo values on leaderboards are stored x1,000,000 (`Elo.ELO_LEADERBOARD_FACTOR`).
Row keys must ALL be present or the client throws: `LeaderboardEntry.CreateFromLeaderboardDataResponse` does `(int)data.GetNumberValue(<countKey>).Value` (no default) -> `INCREASE` (players) / `SUM-COUNT` (guild) / `COUNT` (seasons) / `gamesPlayed` (LeaderboardsEntries) always sent. Unknown shortcode -> `error:{errorCode:36}` (LeaderboardDoesntExist, tolerated) for LeaderboardData; **LeaderboardsEntries must never error or be empty for `PLAYER_ELO_RANKING.*`**: own-entry callback gets null and `UiRework/LeaderboardScreen.cs:129` throws (list never renders, spinner forever). PROD answers an unranked player with some other row (rank 1); server sends a placeholder row without `userId` (client shows the local player unranked). `LeaderboardData`/`AroundMe` answer top-level `data` + `scriptData.entryCount` (not scriptData-wrapped). `social:true` = me + accepted friends + guild members (toggle `OnlyFriendsAndGuildMembers`) with their **global** ranks and the board total as `entryCount`: bracket icons = `GetBracketIdx(rank, entryCount)` (`LeaderboardScreen.cs:82`).
Server impl (`server/src/ranking.ts`): Nakama leaderboards (SET, desc, authoritative) `PLAYER_ELO_RANKING.EXPANSION.<exp>` x12, `GUILD_ELO_RANKING`, `SEASON_ELO_RANKING.<id>`; score = elo*1000, games in record metadata; ELO/XP truth = `mp_stats/main` (profile elo/level/xp are derived from it in `profileFlat`; level starts at 25, xp to leave level L = 100+20L). `rankingRecordGame` (called from mp_game GAME_WON) writes boards, adds season fields to the result rows, pushes LEVEL_PROGRESS. Rename (`ChangeUserDetailsRequest`) rewrites `leaderboard_record.username` (`rankingRename`). Profile `elo` lists played expansions only (missing = "-", client default 1000).

## 4. SHOP_*

### SHOP_GET_CATEGORIES
kind: LogEvent · req: {} · resp: `categories:[string ProductCategoryEnum]` · src: `NS:4035`, `ProductCategory.cs:29` · notes: unknown names ignored. PROD (captured) sends: Coins, Expansion, AvatarCollection, Bundle, BoardTable, BoardPieces, BoardTile. Called at login (`ShopContentController.cs:57`).

### SHOP_PRODUCTS_FOR_CATEGORIES   (menu-critical: shop; also expansion lookups)
kind: LogEvent (durable) · req: {CATEGORIES:[string]} · resp: one key per requested category name -> `[Product]` · src: `NS:3972`, `Product.cs:112`
- Product: `ID`(str), `Name`(str; for Coins/Tickets/Booster `Name` is parsed as int amount - `int.Parse(x.Name)` `ShopController.cs:254`), `Price`(long, in gold; -2121 if absent), `Description`, `IsPurchasable`(bool), `AlreadyBought`(bool), `ConditionText`(str), `assetbundlePath`(str), `isNewProduct`(bool), `discountInfo{date_from,date_to,discountPercentage,discountPrice,discountId}` (`ProductDiscount.cs:15`), bundles: `BundleProducts:[{Name|itemDef.displayName, AlreadyBought, ConditionText, bundleAmount}]`.
- Category `Bundle` => `IsBundle`. Category `Expansion`: `ID` = `ExpansionsEnum` name. Category `Coins`: `ID` = Steam good id (see PAYMENT). Category `AvatarCollection`: `ID` = set-collection id referenced by `Item.setCollection`.
- Client caches each category 10 min; after purchase it force-reloads the category.

### SHOP_GET_EXTERNAL_PRODUCTS
kind: LogEvent · req: {} · resp: `products:[Product]` (the Coins list; only `ID`,`Description`,`Price` used) · src: `NS:1616`, `Common.Payment/PaymentController.cs:115` · notes: called after login to init payment; returning null/error leaves payment uninitialised (`IsInitialized` false -> coin prices stay server-side, no Steam price lookup). Safe stub: `{products:[]}`.

### SHOP_BUY_OFFER   (menu-critical for gold purchases of expansions/items)
kind: LogEvent · req: {OFFERCODE:str (=Product.ID), DISCOUNT_OFFER_ID?:str} · resp: `products:[ {product:{...Product fields...}} ]` — each element parsed with `CreateProductFromGSData(gs, None, key="product")` (nested under `product` OR flat), `Category` string field required when nested (category inferred from `Category`) · src: `NS:3897`, `ShopContentController.cs:272`
- Server must: validate gold, deduct `currency1`, grant (set `expansions` bit / add `virtualGoods` key / add tickets / xp boost), return the updated product(s) with `AlreadyBought:true`. Error -> client shows error via `OnError`; `resp==null` list is treated as failure.
- After success the client calls `AccountDetails` again (`ShopController.cs:~505`) and `PROMOTION_GET_PLAYERS_PROMOTIONS`.

### SHOP_GET_DISCOUNT_OR_NEW_OFFERS
kind: LogEvent · req: {} · resp: `result:{ new:{<Category>:[productId]}, discount:{<Category>:[productId]} }` · src: `NS:4007`, `OfferNewOrDiscountInfo.cs:11` · notes: shop badges; ids owned are filtered client-side. Stub `{result:{new:{},discount:{}}}` (note missing `result` -> no callback).

### SHOP_FIND_CATEGORY_WITH_SET_COLLECTION
kind: LogEvent · req: {COLLECTION_ID:str} · resp: `category:str`, `products:[Product]` · src: `NS:3942`, `ShopContentController.cs:183`, `ShopController.cs:232` · notes: "buy this set" from an avatar item; stub `{category:"", products:[]}`.

## 5. PAYMENT_*  (real money; stub)
Payment system is hard-wired to Steam (`PaymentController.cs:75` -> `SteamPaymentSystem`); `UnityPayment`/PaymentWall are never constructed.
Flow: coin product click -> `PAYMENT_BUY_STEAM_GOOD` -> server calls Steam MicroTxn InitTxn -> Steam overlay -> client callback `MicroTxnAuthorizationResponse_t` -> `PAYMENT_FINALIZE_STEAM_BUY` -> `status=="Success"` -> account refresh.

### PAYMENT_BUY_STEAM_GOOD
kind: LogEvent (durable) · req: {GOOD_ID, LANGUAGE, STEAM_ID, GOOD_DESCRIPTION, LIVE_PAYMENT:1} · resp: `response:{transid?:str}` (stored in `_transId`; no callback) · src: `NS:4056`, `SteamPaymentSystem.cs:62` · notes: the purchase UI waits on the Steam callback, which only Steam can raise, so a pure server stub **hangs the buy dialog**. Stub options: (a) leave Coins category empty / `IsPurchasable:false` + `ConditionText:"Not available"` (recommended; nothing can be clicked), (b) return error so `OnError` pops a dialog, (c) plugin patch `SteamPaymentSystem.Purchase` to call `FinalizeSteamBuy` directly and server grants coins. Always include `response` object (client does `GetGSData("response")` with no null check at FINALIZE).

### PAYMENT_FINALIZE_STEAM_BUY
req: {ORDER_ID, LIVE_PAYMENT} · resp: `response:{status:"Success"}` · src: `NS:4082` · notes: server grants coins from the stored transaction, then account refresh pulls `currency1`.

### PAYMENT_GET_STEAM_PRODUCT_PRICE
req: {PRODUCT_ID_LIST:"id1,id2", STEAM_ID} · resp: `result:[{id, displayPrice, currency}]` (single-id variant uses `.Single()`: exactly one element) · src: `NS:4230,4264` (called only if payment initialised) · stub: omit / return `result:[]` (batch OK; single throws InvalidOperation -> handled, callback(null)).

### PAYMENT_UPDATE_PURCHASE
req: {CURRENCY, PRICE, TRANSID} · resp: none read (errors -> OnError) · src: `NS:4194`; analytics-style, sent after coin purchase success. Return `{}`.

### PAYMENT_FINALIZE_UNITY_BUY
dead (UnityPayment unused: `Common.Payment/UnityPayment.cs:165` has no instantiation).

### PAYMENT_GET_PAYMENTWALL_PRODUCT_PRICE / ACCOUNT_GET_PAYMENTWALL_INFOS
kind: LogEvent · web build only (desktop wrappers `NS:4124,4159`, `NS:3874` have no callers; the WebGL build calls both at startup/shop) · req: `{PRODUCT_ID_LIST:"id1,id2", COUNTRY_CODE}` / `{}` · resp: `result:[{id, amount, currency}]` (single-id variant `.Single()`, empty -> callback(null)) / `{email, creationDate:long, countryCode}` · ours: `result:[]` / empty values (nothing sold, no buyer data).

## 6. ITEM_*

### ITEM_GET_PRODUCT_ITEMS   (menu-critical: avatar/profile/board pieces; blocks `AvatarContentController` until non-empty)
kind: LogEvent · req: {CATEGORIES:["Color","Item","BoardTable","BoardPieces","BoardTile"]} (fixed list, `AvatarContentController.cs:370`) · resp (scriptData): arrays `Color`, `Item`, `BoardPieces`, `BoardTable`, `BoardTile` · src: `NS:3728`, `Item.cs:118`, `ItemColor.cs:46`
- `AreItemsLoaded` requires Colors, Items, GamePieces non-empty and Tables non-empty (`AvatarContentController.cs:38`) - **do not return empty arrays**.
- Item: `ID`(str), `colorId?`, `isLocked?`, `lockedReason?`, `consumable?`, `itemDef:{category (Categories enum name: Back,Beard,Color,Cloth,Eye,Hair,Skin,BoardPieces,BoardTable,Collection,BoardTile,Species), defaultColor?, url3d, url2d, displayName, description, sex (Female|Male|Both; ItemsSex), setCollection?, selectionDisabled?}`. Missing `ID` or `itemDef` => item skipped; unknown category => skipped.
- Color: `ID`, `Price`(int), `itemDef:{displayName, colorCategories:[Categories], colorValue:"RRGGBB"}`, `equipDef:{isLocked, lockedReason?}`.
- Ownership is not in this response (it is `virtualGoods`).
- **Texts:** the client shows `itemDef.displayName`/`description`, `lockedReason`, product `Name`/`Description`/`ConditionText` exactly as sent (`Item.cs:141`, `ItemColor.cs:58`, `Product.cs:125-158`; UI `UiRework/CustomizationItemDescription.cs:21`, `GameHub.Screens/AvatarItemUIEntry.cs:131`, `UiRework/ShopProductEntry.cs:102-229`); there are no per-item loca keys (only the fallback `network_ShopNotPurchasable`). PROD sends its own (localized) texts. `server/data/{items,shop}.json` keep ids + technical fields only (no USM text); the server derives names from the id (`entLabel`: `BOARD_PIECE_VIKING` -> "Board Piece Viking", `CatanSeafarer` -> "Catan Seafarer", coins -> the amount), description "", `Price` -1, level-locked `lockedReason` "Unlocks at level N." (entitlements.ts `entFlagProduct`). Bundle entries need a non-empty `Name` or `itemDef.displayName`, else the client drops them (`Product.cs:154`).
- **PROD capture (2026-10, captures/prod-startup.schema.jsonl)**: ids are `BOARD_PIECE_{BASE,VIKING,ASIA,ORIENT,FANTASY,JESTER}`, `BOARD_TABLE_*`, `BOARD_TILE_{BASE,ASIA,ORIENT,FANTASY}` (no `ITEM_` prefix), variants `ITEM_MALE_JESTER_HAIR1`, `ITEM_FEMALE_SEAFARER_HAIR2`, `ITEM_MALE_HAT_SANTA` (pattern `ITEM_<SEX>_<THEME>_<KIND><n>`), pets `ITEM_PET_*` (itemDef.category `Species`, sex `Pet`, no ColorId). Every entry = `{AlreadyBought, Category, ConditionText, ID, IsPurchasable, Price(-1), equipDef:{isLocked}, itemDef}` (the `isLocked` is inside `equipDef`, not at item level). Counts: Color 34, Item 62, BoardPieces 6, BoardTable 6, BoardTile 4. Board `itemDef` has `priority`, `lvlRequirement`, `setCollection?` (BUNDLE_*_BOARD), `defaultColor` (COLOR_BLACK / COLOR_PLAYER_BLUE), url2d `*.default.jpg`. Colors: `colorCategories` + `colorValue` + `lvlRequirement`; real ids e.g. COLOR_WHEATBLOND, COLOR_WALNUTBROWN(_EYE), COLOR_TERRACOTTA (`tools/gen-items.py` generates items.json from the private capture; the older asset-derived ids below were mostly wrong).
- (superseded) Local derivation: url3d = path under `StreamingAssets/AssetBundles/<BuildID>/Windows/` (male|female/{hair,cloth,beard}, bagpack, pets, board/{pieces,table,tile}). Ids ITEM_MALE_HAIR1 / ITEM_BAGPACK_QUIVER / ITEM_PET_CAT are real (equipmentForLastTime_*.txt, scene strings); variant ids and ITEM_BOARD_* are guesses. Skin/Eye have NO items, only colors (tint). Real colors: CARBONBLACK 1c1914, IVORY f7af93, SAPPHIREBLUE 56a4ff (eye), SAPPHIREBLUE_CLOTH 4C8ED9 (decoded from AI-player thrift files).

### ITEM_EQUIP_ITEM
kind: LogEvent (durable) · req (single): {ITEM_ID, CATEGORY, COLOR_ID, TIMESTAMP}; (bulk, avatar editor): {ITEMS:[{ITEM_ID,CATEGORY,COLOR_ID,TIMESTAMP,UNEQUIP}], SEX?, EYE_COLOR_ID?, SKIN_COLOR_ID?, TIMESTAMP} · resp: avatar block (`lastAvatarChangeTime`(long), `skincolor`, `eyecolor`, `sex`, `equipmentItems:{<Category>:{itemId,url3d,colorId}}`) · src: `NS:3810,3834`, `Common.AvatarSetup/PlayerAvatar.cs:61`, `Item.cs:63`
- Response also passed to `PlayerDetails.Create(data)` + `LocalPlayer.UpdatePlayerDetails` -> `UpdateWithPlayerDetails` overwrites name/expansions/currency/level/elo with whatever is parsed, so the response MUST be the FULL own flat profile (displayName, userId, expansions, currency1/2, ... not only the avatar block). Client timestamps are FileTime (~1.3e17 > 2^53): echo `lastAvatarChangeTime` rounded up; a stale `lastAvatarChangeTime` older than local `TimeCode` is ignored. Server should reject non-owned items.
### ITEM_UNEQUIP_ITEM
req: {ITEM_ID, CATEGORY, TIMESTAMP} · resp: same avatar block · src: `NS:3787`.

## 7. ACCOUNT_* (brief)
- `ACCOUNT_USE_SUN` (`NS:904`): req {GAME_INFO:obj (MultiplayerGameInformation)}; resp ok => `suns:{permanent,temporary,reloadTimes}` (`SunSystem.cs:59`); error => dialog. Server consumes one: if `temporary>0` decrement else push now+N h into `reloadTimes`. With all expansions owned never called. Callers: `ScenarioCardManager.cs:292`, `PlayGame.cs:112`, `BaseSingleplayerOptionsState.cs:433`, `RivalsSinglePlayerState.cs:100`.
- `ACCOUNT_GET_BALANCE`: dead (no wrapper). `ACCOUNT_SET_BALANCE` (`NS:3924`, {MONEY:str}): wrapper `SetAccountbBalance` has no caller -> dead. `ACCOUNT_UNLOCK_CLASSIC` (`NS:629`, {LOGIN,PASSWORD}, resp `unlocked:[ExpansionsEnum names]`): `SendRegisterCatanClassic` has no caller -> dead. Balances travel via account details (`currency1/2`).

## 8. TICKET_UNLOCK_EXPANSION / EXPANSION_*

### TICKET_UNLOCK_EXPANSION
kind: LogEvent · req: {EXPANSION:str ExpansionsEnum} · resp: none read besides errors (success = no `error`) · src: `NS:4297`, `ShopContentController.cs:280` · effect on success: client calls `UpdateDetailsFromServer` => server must have set the `expansions` bit and decremented `currency2`.
### EXPANSION_COMMERCIAL_GET_HINTS
req: {LANGUAGE} · resp: `ExpansionHints:{<ExpansionsEnum>:{entries:[str]}}` · src: `NS:1595`, `ExpansionCommercialController.cs:48` · stub: `{ExpansionHints:{}}` (missing key => `GetGSData` null -> `onDone(null)` ok). Shown by `Common.Screens/ExpansionCommercialScreen.cs:44`; a key with `{}` or `entries:[]` would throw in `GetExpansionHint` (indexes the list without a count check), so every key gets one entry (`data/prod.json`, own text, `tools/gen-items.py`).

## 9. PROMOTION_*

### PROMOTION_GET_PLAYERS_PROMOTIONS
req: {LANGUAGE} · resp: `currentTime`(ISO string - **required**, `DateTime.Parse(null)` throws), `activePromotions:[Promotion]`, `activePromotionsAll:[Promotion]`, optional `activeFeatures:{durationFeatures:{Offer:[Promotion],XPBoost:[...],Expansion:[...]}}` · src: `NS:1528`, `Common.Promotion/Promotion.cs:40`, `PromotionFeature.cs:15`, `PromotionManager.cs:86` (polled every 600 s)
- Promotion: `promotionId,name,description,dateStart,dateEnd` (all required strings; dates parsed), `value`+`valueType`, `imageUrl`, `shown`(bool), `features:[{readableID,dateStart,dateEnd,value,valueType (XPBoost|Expansion|Offer),isPermanent,duration}]`.
- Stub: `{currentTime:<now ISO>, activePromotions:[], activePromotionsAll:[]}`.
### PROMOTION_SEND_CODE
req: {CODE, LANGUAGE} · resp: `promotionResults` ∈ SUCCESSFULL_ACTIVATION|ALREADY_ACTIVATED|UNKNOWN_ERROR|KEY_NOT_EXISTS|KEY_IS_NOT_VALID|USER_HAS_ALREADY_ACTIVATED, `promotion:Promotion` (optional; null tolerated) · src: `NS:1564`, `Common.Promotion/PromotionCodeResults.cs`. Stub: `{promotionResults:"KEY_NOT_EXISTS"}`.
### PROMOTION_SHOWN
req: {ID:str promotionId} · resp: none · src: `NS:1638`.

## 10. ACHIEVEMENTS_INCREASE
kind: LogEvent · req: {ACHIEVEMENT_ID:str (AchievementId name)} · resp: `achievementsProgress:{<id>:{progress:int}}` (full map; replaces local `EarnedAchievements`) · src: `NS:394`, `Common.Net/Achievement.cs:30`, `AchievementController.cs`
- Client skips the call if locally complete; max progress is client-side (`AchievementValuesMapping`). When progress hits max server should push `AchievementEarnedMessage` (section 14). 21 ids in `AchievementId.cs`.

## 11. LEADERBOARD_*
All live ones use `NS` wrappers; elo values in leaderboard rows x1e6.

### LEADERBOARD_FIND_RANKS_FOR_PLAYERNAMES
req: {PLAYERNAME (name prefix; also an exact user id, `ProfileStatisticsScreen.cs:129` passes `playerDetails.Id`), EXPANSION} · resp: `leaderboard:[row]`, `entryCount:int` · row (`LeaderboardEntry.cs:109`): `userId|ownerId`, `userName|username`, `rank`, `ELO`(float x1e6, fallback `score`), `INCREASE`(games, fallback `numScore-1`), `HASFINISHED` · src: `NS:3475`, callers `UiRework/LeaderboardScreen.cs:97`, `GameHub.States/ShowLeaderboardsState.cs:191`. Error `LeaderboardDoesntExist` => empty list tolerated.
### LEADERBOARD_FIND_RANKS_FOR_FRIENDS_LEADERBOARD
req: {EXPANSION} · resp: same as above; rows = me + friends + guild members with global ranks, `entryCount` = board total (client bracket math) · src: `NS:3506`, `LeaderboardScreen.cs:107`.
### LEADERBOARD_GET_BRACKETS
req: {} · resp: `brackets:[int x5]` = % thresholds for GrandMaster,Diamond,Platinum,Gold,Silver (rank% < threshold => that class; else class 5 "none") · src: `NS:3370`, `GameHub.States/LeaderboardBrackets.cs:23,90`. PROD: `[1,5,25,45,85]` (capture 2026-10-21).
### LEADERBOARD_GET_BRACKETS_BY_ID
req: {PLAYER_ID} · resp: `brackets:[int x5]`, `rankPercentages:[{expansion, rankPercentage:int}]` (client then calls `GetBracketIdx(rankPercentage)` = same thresholds as above; server sends `floor(rank*100/total)` = the client's own list formula `rank/count*100` (`LeaderboardBrackets.cs:23`), so profile/result badges match the list icons; only expansions with >= 5 ranked games (placement, `EloEntry.cs:73`): a missing entry shows "x/5 placement" (`ResultStatisticsPlayerEntry.cs:384`)) · src: `NS:3349`, `GameHub.States/LeaderboardBracketEntry.cs:14`; callers: profile/stat screens, `LeaderBoardBracketStore.cs:52`.
### LEADERBOARD_GAME_WON / GAME_LOST / SET_ELO / SET_GUILD_ELO / SET_SEASON_ELO
dead from client (no wrappers). Server updates leaderboards itself on game end (see GAME spec / `GAME_MULTIPLAYER_RESULT`).

## 12. SEASON_*
Seasons are optional; `SEASON_GET_SEASONS_DETAILS` -> `{seasons:[]}` disables everything (`SeasonsController.Current` empty; `CanJoin` false). Polled every 120 s and on details change (`SeasonsController.cs:263`). Season games bypass the expansion check (`isSeason`, `ScenarioCardManager.cs:316`).

### SEASON_GET_SEASONS_DETAILS
req: {} (durable) · resp: `seasons:[Season]` · src: `NS:2281`, `Common.Net/Season.cs:55`
- Season: `id,name,description,date_from,date_to` (ISO, RoundtripKind), `state` (NONE|ISSUED|RUNNING|WAITING|COMPLETED|"COMPLETE"), `expansion` (ExpansionsEnum name; mode shown via `Expansions.GetSeasonState`), `seasonGameModeData`(str), `isLocalPlayerParticipant`, `participationFee`(tickets), `participationFeeGold`, `placementMatches`, `myPlacementMatches`, `leaderboardCount`, `myRank:{userId,userName,rank,ELO,COUNT,HASFINISHED}`, `reward1/2/3:{percentage,scrolls,suns,products:[item entries like Item/RewardItem]}`.
- Client picks: first COMPLETED season where `myRank` exists and not `HASFINISHED` (to show end screen), else first RUNNING.
### SEASON_JOIN
req: {SEASON_ID, PAYMENT: 1=gold / 2=tickets} (durable) · resp: no fields (success = no error) · src: `NS:2246`. Server charges `participationFeeGold` or `participationFee`.
### SEASON_PLAYER_HAS_FINISHED
req: {SEASON_ID} (durable) · resp: if `scriptData` non-empty: either `seasonPlacementMatches:int` (still placing) or `{seasonRank,seasonRankCount,seasonElo,seasonRankCategory(0..2),reward fields (percentage,scrolls,suns,products)}` · src: `NS:2260`, `Common.Net/SeasonEndDetails.cs:21`. Empty `{}` = nothing to show.
### SEASON_GET_LEADERBOARD
req: {SEASON_ID?, OFFSET, COUNT} · resp: `leaderboard:[row (ELO, COUNT keys)]`, `leaderboardCount:int` · src: `NS:2133`.
### SEASON_GET_LEADERBOARD_FOR_PLAYERNAME
req: {SEASON_ID, PLAYERNAME, ENTRY_COUNT} · resp: same · src: `NS:2171`.
### SEASON_GET_PARTICIPANTS / SEASON_GET_PARTICIPANTS_WITH_PLAYERNAME
req: {SEASON_ID, OFFSET, COUNT} / {SEASON_ID, PLAYERNAME, ENTRIES_COUNT} · resp: `participants:[PlayerDetails scriptData-style objects]` (`PlayerDetails.cs:188`) · src: `NS:2202,2224`.
Season pushes SEASON_UPDATED / SEASON_UPCOMING: see section 14 (dead).
Server impl: `server/data/seasons.json` (empty list = seasons off; state derived from `date_from`/`date_to`, `date_to` inclusive). JOIN writes a record (1000 ELO, 0 games) = participant; fee: PAYMENT 1 -> `currency1` (`participationFeeGold`), 2 -> `currency2` (`participationFee`), error 21 if short. Ranked games (`gameInfo.isSeason`, season = `gameInfo.seasonId` or the running one for the expansion) of participants add the normal ELO increase to the season ELO and set `isSeasonParticipant/seasonEloBefore/increaseSeasonElo/seasonPlacementMatches` on the `GAME_MULTIPLAYER_RESULT` row. `myRank`/leaderboard rows use keys `ELO` (x1e6), `COUNT`, `HASFINISHED`. HAS_FINISHED: `{}` unless COMPLETED; then placement count or rank/category (top `reward1.percentage`% -> 0, `reward2` -> 1, else 2) and grants `scrolls` once.

## 13. TOURNAMENT_*
Feature gate: `TOURNAMENT_GET_CONFIG` -> `tournamentConfig.isFeatureEnabled`. Recommended v1: return `{tournamentConfig:{isFeatureEnabled:false}}` and make every other TOURNAMENT_* return `{tournaments:[]}`/ok. Then none of the below is reachable.

### TOURNAMENT_GET_CONFIG   (menu: play mode screen)
req: {} · resp: `tournamentConfig:{isBeta,maxCreationCount(3),maxParticipationCount(10),creationGoldCosts(200),creationMinLevel(5),maxHours(240),minHours(1),maxStartDelayDays(21),maxParticipantsAutoTournament(1000),maxParticipantsCustomTournament(64),isFeatureEnabled,minGamesPlayed(1),maxGamesPlayed(500)}` (Unity JsonUtility, camelCase, missing = defaults above/false) · src: `NS:1941`, `TournamentConfigData.cs:74`. If the call errors / key missing the button stays at its prefab default (unknown - open question).
### TOURNAMENT_GET_LIST
req: {STATE:str GameSparksState, COUNT, OFFSET, SEARCH_STRING, CREATOR_ID, USE_FILTER_IDS:0|1, EXPANSION_FILTER:{expansions:[..]}, FILTER_TOURNAMENT_IDS:{filterTournamentIds:[..]}} · resp: `tournaments:[Tournament]` · src: `NS:2063`, `Common.Net/TournamentData.cs:155`.
- Tournament: `id`(or `_id.$oid`), `name,description,duration`(hours),`startDate`(ISO),`state`,`minKarma,maxKarma,minLevel,maxLevel,minPrestige,maxPrestige,minGamesPlayed,maxGamesPlayed,creatorId,creatorName,creatorAlsoPlays,isCustom,maxPlayers,teamId,memberCount,isFreeTournament,needsConfirmation,onlyMatchOnce,expansions[],rivalsThemeSetTypes[],rivalsGameMode,scenarioIds[],scenarioCalendar:[{expansion,scenarioIds,playersCount,rivalsGameMode,rivalsThemeSetTypes}],customPresets:[{name,expansion,scenarioIds,playersCount,rivalsGameMode,rivalsThemeSetTypes,diceMode,useShuffleMap,useTurnTimer,turnTime,victoryPoints}]`.
### TOURNAMENT_GET_MY_LIST
req: {} · resp: `tournaments:[T]`, `myCreatedTournaments:[T]`, `playersStates:[{tournamentId, accepted, playedGames, alreadyPlayedWithIds, state, elo}]` · src: `NS:2090`.
### TOURNAMENT_CREATE
req: {TOURNAMENT_DATA:obj (fields of Tournament, see `TournamentData.cs:115`), LOCAL_TIME:"yyyy-MM-ddTHH:mm"} (durable) · resp: `tournamentData:T`, `goldAfterPurchase:int` · src: `NS:1860`.
### TOURNAMENT_JOIN / ACCEPT / REMOVE / QUIT
JOIN {TOURNAMENT_ID}; ACCEPT {TOURNAMENT_ID,PLAYER_ID}; REMOVE {TOURNAMENT_ID,PLAYER_ID}; (durable) · resp: success = no error · src: `NS:1883,1899,1916`; QUIT `NS:1929` (wrapper `SendQuitTournamentPlayer` has no caller -> dead).
### TOURNAMENT_PLAYER_UPDATE
req: {TOURNAMENT_ID} · resp: `tournament:T`, `playerUpdate:{playedGames,alreadyPlayedWithIds,state,accepted,elo}` · src: `NS:1840`, `TournamentController.cs:186`. (Also exists as a push, section 14.)
### TOURNAMENT_GET_PARTICIPANTS
req: {TOURNAMENT_ID,COUNT,OFFSET,SEARCH_STRING} · resp: `participants:[PlayerDetails]`, `acceptedIds:[str]` (**both required**, `GetStringList` null-iterated) · src: `NS:1957`.
### TOURNAMENT_GET_LEADERBOARD_FOR_PLAYERNAME
req: {TOURNAMENT_ID,LEADERBOARD_PREFIX ("TOURNAMENT_AUTO.TOURNAMENT_ID." | "TOURNAMENT_CUSTOM.TOURNAMENT_ID."),COUNT,OFFSET,SEARCH_STRING} · resp: `data:[row]` (keys `ELO` or `RANKED_VALUE`, `GAMES_PLAYED`) · src: `NS:2013`. Without search the client uses `LeaderboardDataRequest` with that shortcode.
### TOURNAMENT_GET_GAME_RESULTS
req: {TOURNAMENT_ID,OFFSET,COUNT,FILTER:{expansion?,friendsOnly?,searchString?}} · resp: `results:[{expansion,scenario,themeSets[],challengeId,playerIds[],playerNames[],gameDate,playTime,stats:[...]}]` · src: `NS:2035`, `TournamentGameResult.cs:37`.
### TOURNAMENT_SET_RANKED_VALUE_FOR_PLAYER
req: {TOURNAMENT_ID,PLAYER_ID,RANKED_VALUE:long (=value*1e6)} (durable) · resp: ok · src: `NS:1983`, `GameHub.States/TournamentDetailsState.cs:214`.
### TOURNAMENT_SET_ELO / TOURNAMENT_SET_RANKED_VALUE
dead (no wrappers).

## 14. Pushes
Routing note: only `AchievementEarnedMessage`, `LEVEL_PROGRESS`, `ACCOUNT_PLAYCATAN_BONUS_UNLOCKED`, `SHOP_PURCHASE_RESPONSE` are routed (`NakamaInstance.cs:558,679-697`); SEASON_UPDATED, SEASON_UPCOMING, TOURNAMENT_PLAYER_UPDATE have message classes in `GameSparks.Api.Messages` but **no case in the switch => never delivered; dead on the wire**.

| Push | class / extCode | payload (scriptData-level fields read) | handler | notes |
|---|---|---|---|---|
| `AchievementEarnedMessage` | messageClass `AchievementEarnedMessage` (not ScriptMessage) | `achievementShortCode` (AchievementId name, mandatory), `achievementName,title,subTitle,summary`, `scriptData.achievementsProgress` (full map), `scriptData.xpGain` (ignored) | `NakamaListener.cs:276` -> `AchievementController.OnAchievementEarned` | shown as ticker |
| `LEVEL_PROGRESS` | ScriptMessage / `LEVEL_PROGRESS` | `level:int` (def 1), `tickets:int` (def 0) | `NakamaListener.cs:265`, `LevelProgressHandler.cs:22` | triggers account refresh + item catalog refetch; texts for levels 2,3,4,5,7,10,12,15,20 exist client-side |
| `ACCOUNT_PLAYCATAN_BONUS_UNLOCKED` | ScriptMessage / same | `coins:int`, `tickets:int` | `NakamaListener.cs:887` | reward popup only; server must also add balances |
| `SHOP_PURCHASE_RESPONSE` | ScriptMessage / same | none | `NakamaCallbackInvoker.cs:176-177` calls `ScriptMessage_SHOP_PURCHASE_RESPONSE.Listener(...)` but **no one registers a Listener** => NullReferenceException on the invoker queue. **Never send it.** | dead |
| `SEASON_UPDATED`, `SEASON_UPCOMING` | - | - | none | dead (client polls every 120 s) |
| `TOURNAMENT_PLAYER_UPDATE` | - | would be `{tournament:T, playerUpdate:{...}, reason: NONE|NEW_REQUEST|ACCEPTED_REQUEST|HAS_OPEN_REQUESTS|REMOVE_PLAYER}` (`NakamaListener.cs:247`, `UpdateReason.cs`) | handler registered but never routed | dead; to make it live needs a client patch to `NakamaInstance.ProcessMessage` |

## 15. Menu-critical summary
1. Account details (`expansions`, `virtualGoods`, `currency1/2`, `suns`) - everything else is cosmetic.
2. `ITEM_GET_PRODUCT_ITEMS` non-empty (Color, Item, BoardPieces, BoardTable) - avatar/profile/board skins hang otherwise.
3. `SHOP_GET_CATEGORIES` + `SHOP_PRODUCTS_FOR_CATEGORIES` (shop screen); `SHOP_GET_EXTERNAL_PRODUCTS`, `SHOP_GET_DISCOUNT_OR_NEW_OFFERS` stubs.
4. `PROMOTION_GET_PLAYERS_PROMOTIONS` (needs `currentTime`), `SEASON_GET_SEASONS_DETAILS`, `TOURNAMENT_GET_CONFIG` (polled at login), `LEADERBOARD_GET_BRACKETS_BY_ID`, `EXPANSION_COMMERCIAL_GET_HINTS` - stub to avoid errors/timeouts.
5. `ACHIEVEMENTS_INCREASE` called during play (return the full progress map).
6. `LeaderboardDataRequest` / `LeaderboardsEntriesRequest` + `LEADERBOARD_FIND_RANKS_*` for leaderboard screens.

## 16. Open questions
- Real item ids, bundle names and CDN availability (no catalog in decomp; needs capture or mirror via `bundleURL=`).
- Exact semantics of `Category` field requirement in SHOP_BUY_OFFER nested `product` response (inferred from `Product.cs:112`).
- Default state of the tournament button if TOURNAMENT_GET_CONFIG never answers (prefab-serialised).
- Whether setting season pseudo-expansion bits (0x1000+) has side effects (looks harmless; `HasOnlyArrivalAtCatan` is only affected by bits 1 and 0x40).
- `LogEventResponse` error shape (`Error.Create`) is covered by the ACCOUNT/transport spec.
