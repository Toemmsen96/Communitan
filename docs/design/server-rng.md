# Server-side randomness (anti-cheat), per server: `CATAN_SERVER_RNG=off|seeds|full`

## Findings (decomp, `Catan.*`/`Common.*`)
| Topic | How it works | Src |
|---|---|---|
| Seeds | Creator client: `seed=Environment.TickCount`, `diceSeed=Guid hash`, `colorSeed=DateTime.Ticks` -> `CreateChallengeRequest`. | `Common.Net/HandShakeStartState.cs:50-62` |
| Seed adoption | **Every client incl. the creator** goes Handshake -> GameSetup and takes seeds only from `GAME_GET_GAME_DETAILS_V3` (rejoin: `..._GAMESTATE_AND_ACTIONS_V3`); local values are never applied. | `GameSetupState.cs:66-68`, `RejoinState.cs:39-41`, `NakamaSender.cs:1123,2672` |
| RNG model | Two states in the replicated `CommonGameState`: `RandomNumberState` (seed), `DiceRandomNumberState` (diceSeed). `CreateRNG(variant)`/`CreateDiceRNG(variant)` derive a copy (no stream position); states only advance in `StepRNG` after RollDice/EndTurn. Consumers never disturb each other. | `CommonGameState.cs:70-77,127-154`, `CatanGameComponent.cs:433-439` |
| Board | Start islands + shuffle map: `CreateRNGAndStep(GameStateSeed)` at scenario load; colors: `CreateRNG(colorSeed)`. | `BaseShuffleMapRule.cs:130-136`, `CatanGameComponent.cs:438` |
| Start player | Creator, `UnityEngine.Random`, travels in gameInfo `startPlayer`. | `Common.GameLogic/GameInformation.cs:459` |
| Dice | Player action. Values made at **generation** (`GenerateAll` at context entry, on every client for every seat) with `CreateDiceRNG(NextUniqueId)` and **embedded in the blob**; `Apply` copies `action.DiceValues` unchecked (IsValid = active player only). Dice-stack mode: `DiceStack[0]`, refilled from dice RNG. | `BaseRollDiceRule.cs:25-58,88-94`, `CatanBase_RollDice_GameAction.cs:24-42` |
| Dev cards | Deck shuffled by a **System** action (local on every client, `CreateRNG(NextUniqueId)`, never sent). Buy = Player action embedding `DevCardStack.GetTopElement()`; `Apply` adds the blob's card (and the blob's `AsResourceCosts`!) and removes the top. | `CatanBase_ShuffleDevCardStack_GameAction.cs:24-31`, `CatanBase_BuyDevelopmentCard_GameAction.cs:26-37`, `BuyDevelopmentCardRule.cs:25-35` |
| Robber steal | **System** action `Base_RobPlayer`, computed on every client at apply: `GetRandomResources(1, CreateRNG())`. Not sent. | `CatanBase_RobPlayer_GameAction.cs:22-30`, `BaseRobPlayerRule.cs:15-30` |
| Other (System, local) | C&K progress stacks shuffle/draw, Bishop, Seafarers fog/treasure/harbors, gold field. | `CakShuffleProgressCardStacksRule.cs:16`, `CakProgressCardBishopRule.cs:15`, `CakProgressCardDistributionRule.cs:49`, `FogFieldRule.cs:26`, `TreasureRule.cs:14`, `CatanSeafarer_Shuffle_Harbors_GameAction.cs:32`, `RTTStateChooseGoldfield.cs:28` |
| Received actions | Matched to a locally generated action only by `UniqueId`+`CommonActionId`; the **received payload** is applied. | `ActionContext.cs:177-230` |
| Send path | Only Player-chosen actions go out (`PlayerController.PlayAction` -> `GameSparksConnectionTransport` -> `TaskActionPlayed`); System actions never. **The sender applies its own action only after the `GAME_ACTION_V3` ack.** AI seats: host's `CatanAIPlayerController` uses the same path; turn-timer actions too (`TaskTurntimerActionPlayed` -> `base.OnSuccess`). | `PlayerController.cs:114-122`, `TaskActionPlayed.cs:108-114`, `Multiplayer.cs:185-208` |
| Blob | base64 Thrift TBinary `CommonGameActionState`: 1 commonActionId{1 catanActionId:i32}, 2 playerId, 3 UniqueId, 10 catanGameActionState{1000 asBaseRollDice{1 diceValues:list<i32>}, 1006 asBuyDevelopmentCard{1 developmentCard{1 id,2 cardType}}, 1008 asRobbedResources, 3010 asResourceCosts}, 19 wasActionPlayedByAI, 23 networkSyncId. **Decodable, and dice/card are fixed-width i32: patchable in place.** | `CommonGameActionState.cs:248-327`, `CatanGameActionState.cs:986,1022,1040,1265` |

## Threat model
Every client holds the full `CommonGameState` (all hands, dev cards in hand, deck order, both RNG states) and already
generated the next roll at turn start. A modified client can therefore (a) **predict** dice, deck order, steals, and pick
an action order that changes `NextUniqueId` (e.g. knight before rolling) to get a better roll; (b) **inject** arbitrary
dice / card / resource-cost values in its own blobs (only active-player checks); (c) as creator, **choose seeds** (known
board + dice sequence precomputed offline) and the start player.
| Level | Stops | Does not stop |
|---|---|---|
| off | nothing | a-c |
| seeds (built) | (c) seed choice/precomputation by the creator | (a) prediction once seeds are known (in every client's state), (b) injection, start player, hidden-info peeking |
| full (implemented) | (a) for dice/dev cards/steals/C&K/Seafarers draws, (b) for dice + dev card/stack draws | peeking at hands (full state), forged `AsResourceCosts`/other payloads (needs server-side rules = Level 3: headless GameLogic) |

## Level 1 "seeds" (implemented)
`CATAN_SERVER_RNG=seeds`: `mpCreateChallenge` replaces the 3 seeds with 31-bit values from `nk.uuidv4` (crypto/rand);
client seeds kept in `clientSeeds` for durable-retry detection; status `rng:"seeds"`; mod server list adds "server seeds".
Safe with unmodded clients. Possible add-on: server-chosen `startPlayer` when `randomStartPlayer`.

## Level 2 "full" (implemented)
`CATAN_SERVER_RNG=full` = `seeds` + the following. Server: `server/src/mp_rng.ts` (+ `mpAction` in `mp_game.ts`); mod:
`Communitan/ServerRng.cs`. Everything below only runs for sessions created in full mode (`s.rng`), and in the mod
only on a custom server for the challenge whose details/state said `ccsRngMode:"full"` (Official: never).
| Part | Server | Mod |
|---|---|---|
| Gate | `communitanCaps:"rng-full-1"` required on `MatchmakingRequest`, `LOBBY_CREATE/ACCEPT`, `CreateChallengeRequest`, details, state, actions; else error 110 + `customErrorMessage` ("update the mod", the game shows it in its error popup) | `AddPendingRequest` postfix adds `communitanCaps` to every request on custom servers, only if all RNG patches applied |
| Blob parse | Own TBinary walker (`rngParse`): uid (3), catanActionId (1.1), playerId (2), payload (10), dice offsets (10.1000.1), event die (10.3008.3). Unreadable blob = 110 | - |
| Dice | `Base_RollDice`(3)/`Cak_RollDice`(151): server d6 written into the blob before store/relay; `diceMode` (dice stack) = per-session deck of the 36 pairs (`s.rngStack`), C&K event die always d6. `Cak_PlayProgressCard_Alchemist`(210): event die rewritten, chosen dice kept | Roller adopts the ack's dice (`TaskActionPlayed.OnSuccess` prefix, logs local vs server); `CommonGameState.Apply` prefix also sets them from the record |
| Word | Per accepted action a 64-bit word `w` (record `{u,w,d?}`): ack `ccsRng`, push `data.ccsRng`, state `ccsRng[]` (parallel to `gameActions`), details/state `ccsRngMode`, `ccsRngGen` (= session gen, lobby rematches reuse ids). Stored in the action chunk (`r[]`) | Stashed from responses/pushes (`OnMessageReceived`/`OnNakamaNotification` prefixes) before the game handles them. `CommonGameState.Apply` prefix XORs a key derived from (`w`, uid) into `RandomNumberState` + `DiceRandomNumberState`, once per state object. XOR because actions all players play at once (discards after a 7) arrive in different orders per client: a sequential hash chain desynced the first C&K test game; the game itself relies on those actions commuting |
| UniqueId binding | First accepted payload per uid wins (`s.rngU`); a later blob with the same uid is accepted only with an identical payload (the client really sends some actions twice, once AI-flagged) and gets the same word/dice; otherwise 111. So a probe action cannot reveal the word of a later real action | - |
| Draws | - | All local randomness after an action uses the word-mixed RNG (steal = `BaseRobPlayerRule`, Bishop, ...). Stacks the game shuffles once at start and then takes the top of are re-drawn at Apply: dev card buy + Seafarers treasure card (random card to top), C&K progress card choice (barbarians, C&K+SF treasure), progress distribution after the event die (category shuffled), Seafarers treasure chip, fog tile + number chip (+ fog-island treasure) |

Why a word + local draw instead of a server-owned deck (original design 2.): dev card ids come from a static counter
(`DevelopmentCardDefinition.CreateNextCardId`) and can differ per client, so "remove by id" cannot work; deck contents
are public in the full state anyway; the word approach needs no deck sync and covers every scenario/expansion.
Effect is the same: the card is uniform over the remaining stack and fixed only when the purchase is accepted.

### Limits (what full does NOT stop)
- Every client still holds the full game state: hands, dev cards, remaining stacks are visible to a modified client.
- Other payload fields are trusted (`AsResourceCosts`, chosen resources, trades): needs server-side rules (Level 3).
- Board, start player and the first stack orders come from the (server) seeds, which clients receive; they are public
  or irrelevant (draws re-pick), but a modified client can still "see the board before others render it".
- AI decisions on the host use the mixed RNG (harmless). Rivals/Big Game: not covered (not offered by this server).

### Evidence
- `server/test/mp.test.mjs` (`rngFlow`, full only; off/seeds/full all green): gate, rewritten dice (client sends [7,7]),
  retries/AI-flag copies keep dice+word, other payload with same uid = 111, word unknown before acceptance and identical
  in ack/push/state, alchemist, 40 rolls distribution, dice deck = 36 distinct pairs.
- Real games (`tools/mp-smoke.sh --server ... --first 4`, test build via `GAME_DIR`): see PLAN row 11.
