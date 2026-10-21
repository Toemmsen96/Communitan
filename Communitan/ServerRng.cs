using Catan.GameLogic.Actions;
using Catan.GameLogic.Model;
using Catan.GameLogic.Utilities;
using Common.GameLogic.Model;
using Common.Net;
using GameSparks.Core;
using HarmonyLib;
using Nakama;
using Nakama.Core;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;
using DevCard = Catan.GameLogic.Model.DevelopmentCard;

namespace Communitan
{
    // Server randomness "full" (server CATAN_SERVER_RNG=full, docs/design/server-rng.md). Only active on a custom server,
    // for a challenge whose GAME_GET_GAME_DETAILS_V3 / GAMESTATE_AND_ACTIONS_V3 said ccsRngMode=full; Official servers
    // never send that field and never get our capability token.
    //  - every request carries communitanCaps (a full server refuses clients without it: they would desync)
    //  - the server writes its own dice into roll blobs (receivers apply the blob); the roller adopts the acked dice
    //  - per accepted action the server issues a random word (ack, push, state); applying that action mixes the word into
    //    the replicated RNG state (order-independent XOR), so every later local draw (steal, dev card, C&K/Seafarers draws) is unknown until then
    //  - a dev card purchase takes a random card of the stack (drawn after the purchase's word is mixed in), not the top
    internal static class ServerRng
    {
        internal const string Caps = "rng-full-1";
        private class Rec
        {
            public ulong W;
            public int[] D;
        }

        private static readonly object gate = new object();
        private static string challengeId; // challenge running in full mode (from details/state)
        private static string gen;         // server session generation (lobby rematches reuse the challenge id)
        private static readonly Dictionary<int, Rec> recs = new Dictionary<int, Rec>();
        private static readonly ConditionalWeakTable<CommonGameState, HashSet<int>> mixedByState = new ConditionalWeakTable<CommonGameState, HashSet<int>>();
        private static int mixes, rolls, rollsChanged, draws;
        internal static bool PatchesOk { get; private set; }

        private static bool Verbose => Communitan.autoPlay != null && Communitan.autoPlay.Value != AutoPlayMode.Off;

        internal static void Patch(Harmony harmony)
        {
            try
            {
                harmony.PatchAll(typeof(ServerRng));
                // PatchAll(Type) only processes that type's own methods: the draw re-picks (DevCardDraw, ...) are nested classes.
                List<string> draws = new List<string>();
                foreach (Type t in typeof(ServerRng).GetNestedTypes(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
                {
                    if (t.IsDefined(typeof(HarmonyPatch), false))
                    {
                        harmony.PatchAll(t);
                        draws.Add(t.Name);
                    }
                }
                Communitan.logger.LogInfo($"ServerRng: draw re-picks patched: {string.Join(", ", draws.ToArray())}");
                PatchesOk = true;
            }
            catch (Exception e)
            {
                PatchesOk = false;
                Communitan.logger.LogError($"ServerRng: patches failed ({e.Message}); servers with server dice will refuse this client");
            }
        }

        // Full mode for the running online game? (single player and other challenges: never)
        private static bool Active
        {
            get
            {
                string id = challengeId;
                if (id == null || !ServerList.IsCustomSelected)
                {
                    return false;
                }
                MatchConnectController mc = CommonNetworking.Instance?.MatchConnecting;
                return mc != null && mc.IsMultiplayerRunning && mc.GameInfo != null && mc.GameInfo.ChallengeId == id;
            }
        }

        // ---- capability token on every request (custom servers only) ----
        [HarmonyPatch(typeof(NakamaConnection), "AddPendingRequest")]
        [HarmonyPostfix]
        private static void AddCaps(GSRequest request)
        {
            if (!ServerList.IsCustomSelected || request == null || request.GetString("communitanCaps") != null)
            {
                return;
            }
            // comma list: server dice (all RNG patches applied) + game modes (rules/ switches applied, GameModes.cs)
            string caps = PatchesOk ? Caps : null;
            if (GameModes.PatchesOk)
            {
                caps = caps == null ? GameModes.Caps : caps + "," + GameModes.Caps;
            }
            if (caps != null)
            {
                request.AddString("communitanCaps", caps);
            }
        }

        // ---- server records: responses (ack, details, state) and pushes; stashed before the game handles them ----
        [HarmonyPatch(typeof(NakamaConnection), "OnMessageReceived")]
        [HarmonyPrefix]
        private static void OnResponse(string message)
        {
            if (message == null || (message.IndexOf("ccsRng", StringComparison.Ordinal) < 0 && message.IndexOf("\"diceSeed\"", StringComparison.Ordinal) < 0))
            {
                return;
            }
            try
            {
                JObject sd = JObject.Parse(message)["scriptData"] as JObject;
                if (sd == null)
                {
                    return;
                }
                if (sd["diceSeed"] != null && sd["playerDetails"] != null)
                {
                    // details or gamestate: mode + generation of the session
                    string id = (string)sd["challengeId"];
                    bool full = (string)sd["ccsRngMode"] == "full";
                    lock (gate)
                    {
                        if (!full)
                        {
                            if (id != null && id == challengeId)
                            {
                                challengeId = null;
                            }
                            return;
                        }
                        string g = (string)sd["ccsRngGen"] ?? "";
                        if (id != challengeId || g != gen)
                        {
                            recs.Clear();
                            mixes = rolls = rollsChanged = draws = 0;
                            Communitan.logger.LogInfo($"ServerRng: server dice for challenge {id}");
                        }
                        challengeId = id;
                        gen = g;
                    }
                }
                if (sd["ccsRng"] is JArray list)
                {
                    foreach (JToken t in list)
                    {
                        Add(t);
                    }
                }
                else if (sd["ccsRng"] is JObject one)
                {
                    Add(one);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"ServerRng: bad response: {e.Message}");
            }
        }

        [HarmonyPatch(typeof(NakamaConnection), "OnNakamaNotification")]
        [HarmonyPrefix]
        private static void OnPush(IApiNotification notification)
        {
            string content = notification?.Content;
            if (content == null || content.IndexOf("ccsRng", StringComparison.Ordinal) < 0)
            {
                return;
            }
            try
            {
                JObject data = JObject.Parse(content)["data"] as JObject;
                if (data != null && (string)data["challengeId"] == challengeId)
                {
                    Add(data["ccsRng"]);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"ServerRng: bad push: {e.Message}");
            }
        }

        private static void Add(JToken t)
        {
            if (!(t is JObject o) || o["u"] == null || o["w"] == null)
            {
                return;
            }
            Rec r = new Rec { W = ulong.Parse((string)o["w"], NumberStyles.HexNumber, CultureInfo.InvariantCulture) };
            if (o["d"] is JArray d)
            {
                r.D = d.ToObject<int[]>();
            }
            lock (gate)
            {
                recs[(int)o["u"]] = r;
            }
        }

        private static Rec Get(int uid)
        {
            lock (gate)
            {
                return recs.TryGetValue(uid, out Rec r) ? r : null;
            }
        }

        // ---- roller: apply the server's dice (receivers already get them in the blob) ----
        [HarmonyPatch(typeof(TaskActionPlayed), "OnSuccess")]
        [HarmonyPrefix]
        private static void AdoptAckedDice(TaskActionPlayed __instance)
        {
            if (Active)
            {
                SetDice(__instance.Result?.Action, true);
            }
        }

        private static void SetDice(CommonGameActionState action, bool log)
        {
            Rec r = action != null ? Get(action.UniqueId) : null;
            SelectDiceValue_GameAction alchemist = action?.CatanGameActionState?.AsSelectDices;
            if (alchemist != null && r?.D != null && r.D.Length == 1)
            {
                alchemist.EventDice = r.D[0]; // C&K Alchemist: production dice chosen, event die from the server
                return;
            }
            List<int> dice = action?.CatanGameActionState?.AsBaseRollDice?.DiceValues;
            if (dice == null || r?.D == null || dice.Count < r.D.Length)
            {
                return;
            }
            string local = string.Join(",", dice);
            for (int i = 0; i < r.D.Length; i++)
            {
                dice[i] = r.D[i];
            }
            if (log)
            {
                rolls++;
                string server = string.Join(",", r.D);
                if (local != server)
                {
                    rollsChanged++;
                }
                Communitan.logger.LogInfo($"ServerRng: roll uid={action.UniqueId} local=[{local}] server=[{server}] ({rollsChanged}/{rolls} own rolls changed by the server)");
            }
        }

        // ---- every applied action with a server word: dice from the record, word mixed into the RNG state once ----
        [HarmonyPatch(typeof(CommonGameState), nameof(CommonGameState.Apply))]
        [HarmonyPrefix]
        private static void BeforeApply(CommonGameState __instance, CommonGameActionState action)
        {
            if (action == null || !Active)
            {
                return;
            }
            Rec r = Get(action.UniqueId);
            if (r == null)
            {
                return;
            }
            SetDice(action, false);
            if (!mixedByState.GetOrCreateValue(__instance).Add(action.UniqueId))
            {
                return;
            }
            __instance.RandomNumberState = Mix(__instance.RandomNumberState, r.W, action.UniqueId);
            if (__instance.DiceRandomNumberState != null)
            {
                __instance.DiceRandomNumberState = Mix(__instance.DiceRandomNumberState, r.W ^ 0x9E3779B97F4A7C15UL, action.UniqueId);
            }
            mixes++;
            if (Verbose)
            {
                RandomNumberState s = __instance.RandomNumberState;
                Communitan.logger.LogInfo($"ServerRng: mix #{mixes} uid={action.UniqueId} act={action.CommonActionId?.CatanActionId} rng={s?.X}/{s?.W}");
            }
        }

        // XORs a key derived from (word, uid) into the state. XOR commutes: actions of one context that every player plays at
        // the same time (C&K/base discards after a 7) reach the clients in different orders, the resulting state is the same.
        private static RandomNumberState Mix(RandomNumberState s, ulong w, int uid)
        {
            if (s == null)
            {
                return null;
            }
            FastRandom k = new FastRandom((uint)w | 1u, (uint)(w >> 32), (uint)uid ^ 0x85EBCA6Bu, 0x27D4EB2Fu);
            for (int i = 0; i < 8; i++)
            {
                k.NextUInt(); // diffuse the structured seed
            }
            FastRandom cur = new FastRandom(s); // parses the 4 state words
            RandomNumberState parts = cur.AsState();
            uint a = uint.Parse(parts.X, CultureInfo.InvariantCulture) ^ k.NextUInt();
            uint b = uint.Parse(parts.Y, CultureInfo.InvariantCulture) ^ k.NextUInt();
            uint c = uint.Parse(parts.Z, CultureInfo.InvariantCulture) ^ k.NextUInt();
            uint d = uint.Parse(parts.W, CultureInfo.InvariantCulture) ^ k.NextUInt();
            if ((a | b | c | d) == 0)
            {
                d = 1; // xorshift must not be all zero (2^-128)
            }
            return new RandomNumberState(a.ToString(CultureInfo.InvariantCulture), b.ToString(CultureInfo.InvariantCulture), c.ToString(CultureInfo.InvariantCulture), d.ToString(CultureInfo.InvariantCulture));
        }

        // ---- draws from stacks: a random card of the stack (RNG already holds the triggering action's word), not the
        // known top. The game shuffles its stacks once at game start (predictable) and then always takes the top. ----

        // Dev card: purchase (Base) and Seafarers treasure cards (BuyDevelopmentCardRule.Apply adds the action's card, removes the top).
        [HarmonyPatch]
        private static class DevCardDraw
        {
            private static IEnumerable<System.Reflection.MethodBase> TargetMethods()
            {
                yield return AccessTools.Method(typeof(CatanBase_BuyDevelopmentCard_GameAction), "Apply");
                yield return AccessTools.Method(typeof(CatanSeafarer_Treasure_GetACard_GameAction), "Apply");
                yield return AccessTools.Method(typeof(CatanSeafarer_StartPhase_Treasure_GetACard_GameAction), "Apply");
            }

            private static void Prefix(CommonGameState gameState, CommonGameActionState actionState)
            {
                Base_BuyDevelopmentCard_GameActionState buy = actionState?.CatanGameActionState?.AsBuyDevelopmentCard;
                List<DevCard> cards = gameState?.CatanGameState?.DevCardStack?.Cards;
                if (!Active || buy == null || cards == null || cards.Count == 0)
                {
                    return;
                }
                RandomToEnd(gameState, cards, 0x44455643); // "DEVC"
                buy.DevelopmentCard = cards[cards.Count - 1];
                Note($"dev card uid={actionState.UniqueId} -> {buy.DevelopmentCard.CardType}");
            }
        }

        // C&K progress card of a chosen category: barbarian defenders, C&K+Seafarers treasures (Apply adds ProgressCards[SelectedType], removes the top).
        [HarmonyPatch]
        private static class ProgressCardChoice
        {
            private static IEnumerable<System.Reflection.MethodBase> TargetMethods()
            {
                yield return AccessTools.Method(typeof(CatanCak_BarbariansChooseProgressCard_GameAction), "Apply");
                yield return AccessTools.Method(typeof(CatanCakSf_Treasure_GetACard_GameAction), "Apply");
                yield return AccessTools.Method(typeof(CatanCakSf_StartPhase_Treasure_GetACard_GameAction), "Apply");
            }

            private static void Prefix(CommonGameState gameState, CommonGameActionState actionState)
            {
                ChooseProgresscard_GameActionState choice = actionState?.CatanGameActionState?.AsChooseProgressCard;
                ProgressCardStacks stacks = gameState?.CatanGameState?.ProgressCardStacks;
                if (!Active || choice?.SelectedType == null || choice.ProgressCards == null || stacks == null)
                {
                    return;
                }
                CityImprovementType type = choice.SelectedType.Value;
                List<ProgressCard> list = stacks.GetCategoryList(type);
                if (list == null || list.Count == 0)
                {
                    return;
                }
                RandomToEnd(gameState, list, 0x50524F47 + (int)type); // "PROG"
                choice.ProgressCards[type] = list[list.Count - 1];
                Note($"progress card uid={actionState.UniqueId} {type} -> {list[list.Count - 1].CardType}");
            }
        }

        // C&K progress card distribution after the event die (System action; Apply adds each player's card and removes
        // one top card per player, all from one category): shuffle that category, then hand out its top cards.
        [HarmonyPatch(typeof(CatanCak_DistributeProgressCards_GameAction), "Apply")]
        [HarmonyPrefix]
        private static void DistributeProgressCards(CommonGameState gameState, CommonGameActionState actionState)
        {
            Dictionary<int, ProgressCard> dist = actionState?.CatanGameActionState?.AsProgressCardDistribution?.ProgressCards;
            ProgressCardStacks stacks = gameState?.CatanGameState?.ProgressCardStacks;
            if (!Active || dist == null || dist.Count == 0 || stacks == null)
            {
                return;
            }
            CityImprovementType type = default(CityImprovementType);
            foreach (ProgressCard c in dist.Values)
            {
                type = c.CategoryType;
                break;
            }
            List<ProgressCard> list = stacks.GetCategoryList(type);
            if (list == null || list.Count < dist.Count)
            {
                return;
            }
            Shuffle(gameState, list, 0x44495354 + (int)type); // "DIST"
            List<int> players = new List<int>(dist.Keys);
            players.Sort();
            for (int k = 0; k < players.Count; k++)
            {
                dist[players[k]] = list[list.Count - 1 - k];
            }
            Note($"progress distribution {type}: {players.Count} card(s)");
        }

        // Seafarers treasure chip reached by a ship (System action; Apply takes the action's type off the list).
        [HarmonyPatch(typeof(CatanSeafarer_Check_Treasure_GameAction), "Apply")]
        [HarmonyPrefix]
        private static void Treasure(CommonGameState gameState, CommonGameActionState actionState)
        {
            Treasures_GameActionState t = actionState?.CatanGameActionState?.AsTreasures;
            List<TreasureType> list = gameState?.CatanGameState?.Board?.RandomTreasureList;
            if (!Active || t == null || list == null || list.Count == 0)
            {
                return;
            }
            Shuffle(gameState, list, 0x54524541); // "TREA"
            t.TreasureType = list[0];
            Note($"treasure -> {t.TreasureType}");
        }

        // Seafarers fog tile revealed (System actions): tile type, number chip (and fog-island treasure) from the shuffled lists.
        [HarmonyPatch]
        private static class FogReveal
        {
            private static IEnumerable<System.Reflection.MethodBase> TargetMethods()
            {
                yield return AccessTools.Method(typeof(CatanSeafarer_Check_FogField_GameAction), "Apply");
                yield return AccessTools.Method(typeof(CatanSeafarer_Check_FogField_FogIsland_GameAction), "Apply");
            }

            private static void Prefix(CommonGameState gameState, CommonGameActionState actionState)
            {
                FogField_GameActionState f = actionState?.CatanGameActionState?.AsFogField;
                BoardState board = gameState?.CatanGameState?.Board;
                if (!Active || f == null || board == null)
                {
                    return;
                }
                if (board.RandomTreasureList != null)
                {
                    Shuffle(gameState, board.RandomTreasureList, 0x54524541);
                }
                if (f.TileType == TileTypes.Undefined || board.RandomLandTileList == null || board.RandomLandTileList.Count == 0)
                {
                    return;
                }
                Shuffle(gameState, board.RandomLandTileList, 0x464F4754); // "FOGT"
                f.TileType = board.RandomLandTileList[0];
                if (f.TileType != TileTypes.Water && f.TileType != TileTypes.Desert && board.RandomValueChipList != null)
                {
                    Shuffle(gameState, board.RandomValueChipList, 0x464F4743); // "FOGC"
                    f.ValueChip = Catan.GameLogic.Rules.ValueChipRule.GetValueChip(gameState.CatanGameState, f.TilePosition.AsFacePos);
                }
                Note($"fog -> {f.TileType} {f.ValueChip}");
            }
        }

        // Swaps an element chosen by the (word-mixed) game RNG to the end of the list (the "top" of the game's stacks).
        private static void RandomToEnd<T>(CommonGameState gameState, List<T> list, int variant)
        {
            if (list.Count < 2)
            {
                return;
            }
            int i = gameState.CreateRNG(variant).Next(list.Count);
            int last = list.Count - 1;
            T tmp = list[i];
            list[i] = list[last];
            list[last] = tmp;
        }

        private static void Shuffle<T>(CommonGameState gameState, List<T> list, int variant)
        {
            FastRandom rng = gameState.CreateRNG(variant);
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = rng.Next(i + 1);
                T tmp = list[i];
                list[i] = list[j];
                list[j] = tmp;
            }
        }

        private static void Note(string msg)
        {
            draws++;
            if (Verbose)
            {
                Communitan.logger.LogInfo($"ServerRng: {msg} (#{draws})");
            }
        }
    }
}
