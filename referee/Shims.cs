// Harmony shims (installed once per process):
//  (1) Unity coupling on the action path (docs/design/level3-referee.md "Findings"): rules TextAsset, tutorial singleton,
//      longest road via PlayerController.DataCache, MP map shuffle seed via CommonNetworking. InternalCalls are stubbed
//      offline (referee/stubber), hits are counted.
//  (2) Communitan L2 "full" server RNG (port of Communitan/ServerRng.cs, docs/design/server-rng.md): per-action word
//      XOR-mixed into both RNG states before Apply, dev card re-drawn at Apply. Base game: no other draw re-picks apply.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using Catan.GameLogic.Actions;
using Catan.GameLogic.Model;
using Catan.GameLogic.Model.Advanced;
using Catan.GameLogic.Rules;
using Catan.GameLogic.Utilities;
using Common.GameLogic.Model;
using HarmonyLib;
using Thrift.Utilities;

static class Shims
{
    public static readonly ConcurrentDictionary<string, int> Hits = new ConcurrentDictionary<string, int>();
    static void Hit(string k) => Hits.AddOrUpdate(k, 1, (_, v) => v + 1);

    public static void Install()
    {
        var h = new Harmony("communitan.referee");
        Patch(h, typeof(CommonGameState), nameof(CommonGameState.Apply), nameof(BeforeApply));
        Patch(h, typeof(CatanBase_BuyDevelopmentCard_GameAction), "Apply", nameof(DevCardDraw));
        Patch(h, typeof(CatanGameRulesSerializer), nameof(CatanGameRulesSerializer.LoadFromGame), nameof(LoadRules));
        Patch(h, typeof(Common.IngameMenu.ViewControllers.BaseTutorialController), "get_IsTutorialRunning", nameof(RetFalse));
        Patch(h, typeof(BaseCheckLongestRoadRule), "GenerateAllPlayerLongestRoad", nameof(AllLongestRoads));
        Patch(h, typeof(BaseCheckLongestRoadRule), nameof(BaseCheckLongestRoadRule.CalculateRoadLengthOfPlayer), nameof(RoadLength));
        Patch(h, typeof(BaseShuffleMapRule), "CreateRandomNumberGenerator", nameof(ShuffleRng));
        var hook = Type.GetType("UnityEngine.L3Stub, UnityEngine.CoreModule")?.GetField("OnHit");
        if (hook == null) throw new Exception("UnityEngine.CoreModule is not the stubbed copy (run tools/referee-setup.sh)");
        hook.SetValue(null, (Action<string>)(n => Hit("icall " + n)));
        InstallSingletons();
    }

    static void Patch(Harmony h, Type t, string method, string prefix)
    {
        var m = AccessTools.Method(t, method) ?? throw new Exception($"shim target missing: {t.Name}.{method} (game version?)");
        h.Patch(m, prefix: new HarmonyMethod(typeof(Shims), prefix));
    }

    // Scene singletons the rules read (null without a scene): blank, uninitialized instances.
    static void InstallSingletons()
    {
        foreach (var name in new[] { "Common.IngameMenu.ViewControllers.TutorialController" })
        {
            var t = AccessTools.TypeByName(name);
            var prop = AccessTools.Property(t, "Instance");
            object o = RuntimeHelpers.GetUninitializedObject(t);
            if (prop?.GetSetMethod(true) != null && prop.DeclaringType == t) prop.GetSetMethod(true).Invoke(null, new[] { o });
            else
            {
                var bt = t;
                while (bt != null && !(bt.IsGenericType && bt.GetGenericTypeDefinition().Name.StartsWith("MonoBehaviourSingleton"))) bt = bt.BaseType;
                AccessTools.Property(bt, "Instance").GetSetMethod(true).Invoke(null, new[] { o });
            }
        }
    }

    static bool RetFalse(ref bool __result, MethodBase __originalMethod) { Hit(__originalMethod.Name); __result = false; return false; }

    // CatanGameRulesSerializer.cs:18 Resources.Load<TextAsset>("rules/catan/CatanGameRules")
    static bool LoadRules(ref CatanGameRules __result)
    {
        Hit("rules");
        Serializer.CurrentFormat = Serializer.Format.binary;
        __result = Serializer.LoadAsText<CatanGameRules>(GameData.RulesText);
        return false;
    }

    // BaseShuffleMapRule.cs:130 MP: CreateRNGAndStep(CommonNetworking...GameStateSeed)
    static bool ShuffleRng(CommonGameState gameState, ref FastRandom __result)
    {
        Hit("shuffle");
        __result = gameState.CreateRNGAndStep(Replay.Current.Seed);
        return false;
    }

    // BaseCheckLongestRoadRule.cs:109,133 read PlayerController.DataCache (scene object): same cache, built from the state.
    static int Len(CatanGameState gs, int p)
    {
        var c = new CatanPlayerDataCache(gs, p, new ActionMultiMap());
        c.SetDirtyRoads();
        return c.LongestRoadLength(p);
    }
    static bool AllLongestRoads(CatanGameState gameState, ref List<(int, int)> __result)
    {
        Hit("longestRoad");
        __result = new List<(int, int)>();
        for (int i = 0; i < gameState.Player.Count; i++) __result.Add((i, Len(gameState, i)));
        return false;
    }
    static bool RoadLength(CatanGameState gameState, int playerId, ref int __result) { __result = Len(gameState, playerId); return false; }

    // ---- L2 full mode (Communitan/ServerRng.cs BeforeApply / Mix / DevCardDraw) ----
    static readonly ConditionalWeakTable<CommonGameState, HashSet<int>> mixed = new ConditionalWeakTable<CommonGameState, HashSet<int>>();

    static void BeforeApply(CommonGameState __instance, CommonGameActionState action)
    {
        var r = Replay.Current;
        if (r == null || !r.FullRng || action == null || !r.Words.TryGetValue(action.UniqueId, out ulong w)) return;
        if (!mixed.GetOrCreateValue(__instance).Add(action.UniqueId)) return;
        __instance.RandomNumberState = Mix(__instance.RandomNumberState, w, action.UniqueId);
        if (__instance.DiceRandomNumberState != null)
            __instance.DiceRandomNumberState = Mix(__instance.DiceRandomNumberState, w ^ 0x9E3779B97F4A7C15UL, action.UniqueId);
        r.Mixes++;
    }

    public static RandomNumberState Mix(RandomNumberState s, ulong w, int uid)
    {
        if (s == null) return null;
        var k = new FastRandom((uint)w | 1u, (uint)(w >> 32), (uint)uid ^ 0x85EBCA6Bu, 0x27D4EB2Fu);
        for (int i = 0; i < 8; i++) k.NextUInt();
        var parts = new FastRandom(s).AsState();
        uint a = uint.Parse(parts.X, CultureInfo.InvariantCulture) ^ k.NextUInt();
        uint b = uint.Parse(parts.Y, CultureInfo.InvariantCulture) ^ k.NextUInt();
        uint c = uint.Parse(parts.Z, CultureInfo.InvariantCulture) ^ k.NextUInt();
        uint d = uint.Parse(parts.W, CultureInfo.InvariantCulture) ^ k.NextUInt();
        if ((a | b | c | d) == 0) d = 1;
        return new RandomNumberState(a.ToString(CultureInfo.InvariantCulture), b.ToString(CultureInfo.InvariantCulture), c.ToString(CultureInfo.InvariantCulture), d.ToString(CultureInfo.InvariantCulture));
    }

    // ServerRng.DevCardDraw: a random card of the stack (word-mixed RNG) is swapped to the top and becomes the bought card.
    static void DevCardDraw(CommonGameState gameState, CommonGameActionState actionState)
    {
        var r = Replay.Current;
        var buy = actionState?.CatanGameActionState?.AsBuyDevelopmentCard;
        var cards = gameState?.CatanGameState?.DevCardStack?.Cards;
        if (r == null || !r.FullRng || buy == null || cards == null || cards.Count == 0) return;
        if (cards.Count >= 2)
        {
            int i = gameState.CreateRNG(0x44455643).Next(cards.Count); // "DEVC"
            int last = cards.Count - 1;
            var tmp = cards[i]; cards[i] = cards[last]; cards[last] = tmp;
        }
        buy.DevelopmentCard = cards[cards.Count - 1];
        r.Draws++;
    }

    // Static game state shared by all replays of this process: back to a fresh process' values.
    public static void ResetStatics()
    {
        HexGridLinks.Instance.Reset();
        typeof(DevelopmentCardDefinition).GetField("idCounter", BindingFlags.Static | BindingFlags.NonPublic)?.SetValue(null, 0);
        typeof(CatanBoardCache).GetMethod("Reset", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null);
    }
}
