// One replay = one /v1/replay request. Mirrors the client: CatanGameComponent.CreateGameStateForMP (scenario + seeds +
// static state + map shuffle) -> CatanGameLogicSetup.SetupNewGame -> GameLogic, then the rejoin path
// (GameLogic.StartApplyHistory / ApplyHistoryAction, Common.GameLogic/GameLogic.cs:534-600) for every stored action,
// each judged against the game's own generated reference first (Checks.cs).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json.Nodes;
using Catan.GameLogic.Game;
using Catan.GameLogic.Model;
using Catan.GameLogic.Rules;
using Catan.GameLogic.Utilities;
using Common.GameLogic;
using Common.GameLogic.Actions;
using Common.GameLogic.Model;
using Thrift.Utilities;

class Replay
{
    public static Replay Current; // static game state: one replay at a time (Server serializes requests)

    static readonly MethodInfo applySysAuto = typeof(GameLogic).GetMethod("ApplySystemAutoForHistory", BindingFlags.NonPublic | BindingFlags.Instance);
    static readonly MethodInfo setPlayerActionId = typeof(GameLogic).GetMethod("SetPlayerActionId", BindingFlags.NonPublic | BindingFlags.Instance);

    readonly JsonObject session;
    readonly JsonArray input;
    public readonly Dictionary<int, ulong> Words = new Dictionary<int, ulong>();
    public bool FullRng;
    public int Seed;
    public int Mixes, Draws;
    public List<string> Seats;
    public CommonGameState State;

    public Replay(JsonObject req)
    {
        session = (JsonObject)req["session"];
        input = (JsonArray)req["actions"];
    }

    static JsonObject Unsupported(string why) => new JsonObject { ["supported"] = false, ["ok"] = false, ["reason"] = why };

    class In { public int Idx; public CommonGameActionState A; public string By; }

    public JsonObject Run()
    {
        var sw = Stopwatch.StartNew();
        var gi = session["gameInfo"] as JsonObject ?? new JsonObject();
        Seats = ((session["seats"] ?? gi["sortedPlayerIds"]) as JsonArray)?.Select(x => (string)x).ToList() ?? new List<string>();
        var humans = (session["humans"] as JsonArray)?.Select(x => (string)x).ToList() ?? Seats;
        var exps = (gi["expansions"] as JsonArray)?.Select(x => (string)x).ToList() ?? new List<string>();
        string scenario = (gi["scenarios"] as JsonArray)?.Select(x => (string)x).FirstOrDefault();
        string rng = ((string)session["rng"] ?? "off").ToLowerInvariant();
        if (exps.Count != 1 || exps[0] != "CatanBaseGame") return Unsupported("expansions " + string.Join(",", exps));
        if (!GameData.TryScenario(scenario, out string scenarioText, out int shuffleMode)) return Unsupported("scenario " + scenario);
        if (Seats.Count < 2 || Seats.Count > 6) return Unsupported("players " + Seats.Count);
        if (rng != "off" && rng != "seeds" && rng != "full") return Unsupported("rng " + rng);
        FullRng = rng == "full";
        Seed = (int)session["seed"];

        // ---- decode (server stores the blobs exactly as relayed: base64 Thrift CommonGameActionState) ----
        Serializer.CurrentFormat = Serializer.Format.binary;
        var acts = new List<In>();
        for (int i = 0; i < input.Count; i++)
        {
            var n = input[i];
            string blob = n is JsonObject o ? (string)o["a"] : (string)n;
            string by = n is JsonObject o2 ? (string)o2["by"] : null;
            CommonGameActionState a;
            try { a = Serializer.LoadAsText<CommonGameActionState>(blob); }
            catch (Exception e) { a = null; if (by == null) return Verdict(sw, null, Desync(-1, "undecodable action #" + i + ": " + e.Message)); }
            if (a == null) return Verdict(sw, Invalid(-1, -1, by, "?", "undecodable action #" + i), null);
            if (n is JsonObject o3 && o3["w"] != null && FullRng)
                Words[a.UniqueId] = ulong.Parse((string)o3["w"], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            acts.Add(new In { Idx = i, A = a, By = by });
        }
        // uid order = play order (each applied action regenerates the context's actions with fresh uids); stable for resends
        acts = acts.OrderBy(x => x.A.UniqueId).ThenBy(x => x.Idx).ToList();

        Current = this;
        try
        {
            Shims.ResetStatics();
            // ---- CatanGameComponent.CreateGameStateForMP (Catan.Unity.Components/CatanGameComponent.cs:402-470) ----
            var gs = Serializer.LoadAsText<CommonGameState>(scenarioText);
            gs.RandomNumberState = new FastRandom(Seed).AsState();
            gs.DiceRandomNumberState = new FastRandom((int)session["diceSeed"]).AsState();
            var st = gs.CatanGameState.StaticState;
            st.PlayerCount = Seats.Count;
            st.FriendlyRobberActive = (bool?)gi["friendlyRobber"] ?? false;
            st.DiceStackActive = (bool?)gi["diceMode"] ?? false;
            st.RoundTimerActive = (bool?)gi["useTurnTimer"] ?? false;
            st.RoundTime = (int?)gi["turnTime"] ?? 90;
            st.VictoryPoints = (int?)gi["victoryPoints"] ?? 10;
            st.UseShuffleMap = (bool?)gi["useShuffleMap"] ?? false;
            st.ScenarioTextKey = scenario;
            gs.CatanGameState.Match.StartPlayerId = (int?)gi["startPlayer"] ?? 0;
            BaseShuffleMapRule.ShuffleStartIslands(gs, (Common.Unity.ShuffleMode)shuffleMode);
            if (st.UseShuffleMap == true) BaseShuffleMapRule.ShuffleMap(gs, (Common.Unity.ShuffleMode)shuffleMode);
            gs.ColorIdByPlayerId = new Dictionary<string, GameColor>(); // cosmetic (CreateRNG does not advance the state)
            if (gs.GameStateInfo == null) gs.GameStateInfo = GameStateInfo.CreateEmpty();

            // ---- CatanServerComponent.CreateNewServer -> CatanGameLogicSetup.SetupNewGame + players ----
            var logic = new GameLogic(CatanGameLogicSetup.SetupNewGame(gs), new CatanGameLogicExtension());
            for (int i = 0; i < Seats.Count; i++)
                logic.CreateNewPlayer(Seats[i], i, humans.Contains(Seats[i]) ? PlayerType.Human : PlayerType.PermanentAI);
            State = logic.GameState;
            // CommonGameComponent.SetupGameLogic -> CatanBoardCache.Init minus ThemesetReferenceManager (scene object)
            CatanBoardCache.Reset();
            typeof(CatanBoardCache).GetMethod("SetupFirst", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { State.CatanGameState });
            logic.StartApplyHistory();

            // ---- history ----
            var seen = new HashSet<int>();
            int applied = 0, dups = 0, obsolete = 0;
            foreach (var x in acts)
            {
                var act = x.A;
                string aid = act.CommonActionId?.ToSerializedString() ?? "?";
                int seat = act.PlayerId ?? -1;
                CommonGameActionState gen = ActionContext.GetGameActionReference(act, State);
                if (gen == null)
                {
                    // Clients ignore an action no context generated (FailedObsolete: a resend or an action of an earlier
                    // context). One beyond NextUniqueId was never offered by the rules at all: e.g. a build the player can't
                    // afford (no build action is generated), sent by a modified client ("free build" cheats) -> invalid.
                    // 0 such actions in the recorded honest games (referee/test/fixtures, bot games).
                    if (act.UniqueId > State.ContextState.NextUniqueId.GetValueOrDefault(int.MaxValue))
                        return Verdict(sw, Invalid(act.UniqueId, seat, x.By, aid, "not offered by the rules (no such action at this point; next uid " + State.ContextState.NextUniqueId + ")"), null, applied, dups, obsolete);
                    if (seen.Contains(act.UniqueId)) dups++; else obsolete++;
                    continue;
                }
                string why = Checks.Compare(this, act, gen);
                if (why != null) return Verdict(sw, Invalid(act.UniqueId, seat, x.By, aid, why), null, applied, dups, obsolete);
                ActionContext.ApplyActionResult res;
                try
                {
                    res = ActionContext.ApplyGameAction(act, State);
                    if (res == ActionContext.ApplyActionResult.Successful) setPlayerActionId.Invoke(logic, new object[] { act });
                    if (res == ActionContext.ApplyActionResult.FailedInvalid)
                        return Verdict(sw, Invalid(act.UniqueId, seat, x.By, aid, "rules: IsValid failed"), null, applied, dups, obsolete);
                    applySysAuto.Invoke(logic, null);
                }
                catch (Exception e)
                {
                    e = e is TargetInvocationException tie ? tie.InnerException : e;
                    return Verdict(sw, null, Desync(act.UniqueId, $"{aid} threw {e.GetType().Name}: {e.Message}"), applied, dups, obsolete);
                }
                seen.Add(act.UniqueId);
                applied++;
            }
            return Verdict(sw, null, null, applied, dups, obsolete);
        }
        finally
        {
            Current = null;
        }
    }

    JsonObject Invalid(int uid, int seat, string by, string actionId, string reason)
    {
        var o = new JsonObject { ["uid"] = uid, ["seat"] = seat, ["playerId"] = seat >= 0 && seat < Seats.Count ? Seats[seat] : null, ["actionId"] = actionId, ["reason"] = reason };
        if (by != null) o["senderId"] = by;
        return o;
    }

    static JsonObject Desync(int uid, string result) => new JsonObject { ["uid"] = uid, ["result"] = result };

    JsonObject Verdict(Stopwatch sw, JsonObject invalid, JsonObject desync, int applied = 0, int dups = 0, int obsolete = 0)
    {
        var v = new JsonObject { ["supported"] = true };
        bool finished = false;
        var ranks = new JsonArray();
        var winners = new JsonArray();
        if (State != null)
        {
            var ctx = State.ContextState;
            finished = ctx.LastPlayedActionId?.ToSerializedString() == "Base_WinGame" || ctx.CurrentContextId?.ToReadableString() == "Base_Win";
            var cgs = State.CatanGameState;
            var won = new HashSet<int>();
            if (finished) try { foreach (int p in WinRule.GetWinners(State)) won.Add(p); } catch (Exception) { /* fall back to VP order */ }
            var rows = Enumerable.Range(0, cgs.Player.Count).Select(p => (seat: p, vp: CatanGameUtils.GetVictoryPointsForCurrentExpansion(p, cgs), win: won.Contains(p))).ToList();
            // StatisticsUtils.GetWinLoseStatsForCatan (Common.Net.PlayerStatistics/StatisticsUtils.cs:237): dense rank by VP; winners first
            rows = rows.OrderByDescending(r => r.win).ThenByDescending(r => r.vp).ToList();
            int rank = 0; (bool, int)? prev = null;
            foreach (var r in rows)
            {
                if (prev == null || prev.Value != (r.win, r.vp)) rank++;
                prev = (r.win, r.vp);
                ranks.Add(new JsonObject { ["playerId"] = r.seat < Seats.Count ? Seats[r.seat] : null, ["seat"] = r.seat, ["vp"] = r.vp, ["rank"] = rank });
                if (r.win) winners.Add(r.seat < Seats.Count ? Seats[r.seat] : null);
            }
        }
        if (invalid == null && desync == null && !finished) desync = Desync(-1, "NotFinished (last " + State?.ContextState.LastPlayedActionId?.ToSerializedString() + ")");
        v["ok"] = invalid == null && desync == null;
        v["finished"] = finished;
        v["winners"] = winners;
        v["ranks"] = ranks;
        if (invalid != null) v["invalid"] = invalid;
        if (desync != null) v["desync"] = desync;
        v["stats"] = new JsonObject { ["actions"] = input.Count, ["applied"] = applied, ["dups"] = dups, ["obsolete"] = obsolete, ["checked"] = Checks.Count, ["mixes"] = Mixes, ["draws"] = Draws, ["ms"] = sw.ElapsedMilliseconds };
        Checks.Count = 0;
        return v;
    }
}
