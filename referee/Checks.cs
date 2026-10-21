// Per-action check: the received action vs the reference the game generated for the same UniqueId + action id
// (ActionContext.GetGameActionReference, Common.GameLogic.Actions/ActionContext.cs:177). The game's own IsValid is weak
// (positions, costs, trades unchecked: BuildRoadRule.cs:10, TradeFinishRule.cs:7, BuyDevelopmentCardRule.cs:8).
// Default = every field equal ("fixed"). Exceptions, by field path (optionally "<actionId>|<path>" for one action):
//   Rules  - choice fields: checked by a validator (e.g. selected position within the generated valid set)
//   Ignore - sender metadata / values legitimately differing per client (card ids, RNG-owned values in "full" mode)
// Add a check: put a path (+ validator) into Rules. Unknown differences are reported as "<path> differs".
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Catan.GameLogic.Model;
using Common.GameLogic.Model;
using DevCard = Catan.GameLogic.Model.DevelopmentCard;

static class Checks
{
    public static int Count;
    public static readonly bool Calibrate = Environment.GetEnvironmentVariable("REFEREE_CALIBRATE") == "1";
    public static readonly SortedDictionary<string, int> Seen = new SortedDictionary<string, int>(); // calibration: action|path -> count

    delegate string Rule(Replay r, CommonGameActionState recv, CommonGameActionState gen, object rv, object gv);

    // Fields ignored everywhere (sender/transport metadata).
    static readonly HashSet<string> Ignore = new HashSet<string>
    {
        "WasActionPlayedByAI", "ActionPlayedByPlayerIdx", "TurntimerRanOutPlayerId", "TurntimerPlayedByPlayerId", "NetworkSyncId",
    };

    const string C = "CatanGameActionState.";

    // Choice fields (calibrated on recorded honest base games: these are the only fields that differ from the reference).
    // null = not checked here (unused by Apply, or fully covered by the game's IsValid once the fixed fields are verified).
    static readonly Dictionary<string, Rule> Rules = new Dictionary<string, Rule>
    {
        // build / start phase / robber: the position must be one the rules offered (BuildRoadRule.cs:10 does not check it)
        [C + "AsCandidates.SelectedPosition"] = (r, a, g, rv, gv) =>
            rv == null ? "missing" : (g.CatanGameActionState.AsCandidates.ValidPositions ?? new List<HexGridPosition>()).Any(p => p.Equals(rv)) ? null : "not a valid position " + rv,
        ["Base_BuildCity|" + C + "AsCandidates.PrevType"] = (r, a, g, rv, gv) => Equals(rv, gv) || Equals(rv, GamePieceType.Settlement) ? null : $"previous piece {rv}",
        [C + "AsCandidates.SelectedType"] = (r, a, g, rv, gv) => Equals(rv, gv) || PieceFor(a) is GamePieceType t && Equals(rv, t) ? null : $"piece {rv}",
        // dice: fixed in off/seeds (generated at context entry from the dice RNG); "full": the server's dice (mp_rng.ts) are in the blob
        [C + "AsBaseRollDice.DiceValues"] = (r, a, g, rv, gv) => r.FullRng ? (((List<int>)rv)?.All(d => d >= 1 && d <= 6) == true ? null : "dice") : Same(rv, gv) ? null : "forged dice " + string.Join(",", (List<int>)rv),
        // dev card: the top of the stack at generation (fixed; card ids are per-process counters). Also in "full": the card is
        // re-drawn at Apply (Shims.DevCardDraw), but an honest client still embeds the pre-redraw top, which the referee
        // generates identically; a different card = a modified client (e.g. a forced card type).
        [C + "AsBuyDevelopmentCard.DevelopmentCard"] = (r, a, g, rv, gv) =>
            rv is DevCard x && gv is DevCard y && x.CardType == y.CardType && x.BackType == y.BackType && x.BoughtInTurn == y.BoughtInTurn ? null : $"card {(rv as DevCard)?.CardType}",
        // robber: rob target among the offered players; discard: own cards, amount checked by BaseRobberRule.IsValid
        [C + "AsSelectAblePlayers.SelectedPlayer"] = (r, a, g, rv, gv) => rv is int p && (g.CatanGameActionState.AsSelectAblePlayers.PlayersList?.Contains(p) ?? false) ? null : $"player {rv} not selectable",
        [C + "AsRobbedResources.ChosenResources"] = (r, a, g, rv, gv) => Owned(r, a.PlayerId ?? -1, rv as CardBundleModel),
        // dev cards: Monopoly type (any base resource), Inventor/Year of Plenty: exactly ResourcesToChoose base resources
        [C + "AsResourceTypeToChoose.ChosenResourceType"] = (r, a, g, rv, gv) => rv is BaseResourceType t && Enum.IsDefined(typeof(BaseResourceType), t) ? null : "resource type",
        [C + "AsResourcesToChoose.ChosenResources"] = (r, a, g, rv, gv) =>
            Base(rv as CardBundleModel) ?? (((CardBundleModel)rv).GetTotalAmount() == g.CatanGameActionState.AsResourcesToChoose.ResourcesToChoose ? null : "amount"),
        // bank trade: Apply and IsValid use AsTradeFinish.Offer + the (fixed, verified) AsTradeInit.Ratio: BankTradeInitRule.IsBankTradeBaseValid
        ["Trade_Bank|" + C + "AsTradeInit.Offer"] = null,
        ["Trade_Bank|" + C + "AsTradeFinish.Offer"] = (r, a, g, rv, gv) => Base(((TradeOffer)rv)?.Give) ?? Base(((TradeOffer)rv)?.Want),
        ["Trade_Bank|" + C + "AsTradeFinish.Is2to1Bank"] = null, // Inka only
        // player trade: TradeFinishRule.IsValid only checks the active player. Both sides must own what they hand over.
        // Consent of the accepting player (GAME_TRADE relay) is not verified yet.
        ["Trade_FinishTrade|" + C + "AsTradeFinish.OffererPlayerId"] = (r, a, g, rv, gv) => Equals(rv, a.PlayerId) ? null : $"offerer {rv} is not the active player",
        ["Trade_FinishTrade|" + C + "AsTradeFinish.AcceptedPlayerId"] = (r, a, g, rv, gv) => rv is int p && p >= 0 && p < r.Seats.Count && p != a.PlayerId ? null : $"partner {rv}",
        ["Trade_FinishTrade|" + C + "AsTradeFinish.Offer"] = (r, a, g, rv, gv) =>
        {
            var o = rv as TradeOffer;
            var f = a.CatanGameActionState.AsTradeFinish;
            if (o == null || o.Give == null || o.Want == null) return "missing offer";
            return Owned(r, f.OffererPlayerId, o.Give) ?? Owned(r, f.AcceptedPlayerId, o.Want);
        },
    };

    // Ids from per-process counters: never compared.
    static readonly string[] IgnoreSuffix = { ".DevelopmentCard.Id", ".AsDevelopmentCard.Id", ".Card.Id" };

    static GamePieceType? PieceFor(CommonGameActionState a)
    {
        switch (a.CommonActionId?.ToSerializedString())
        {
            case "Base_BuildRoad": case "Base_StartPhase_BuildRoad": case "Base_BuildFreeRoad": case "Base_StartPhase_BuildFreeRoad": return GamePieceType.Road;
            case "Base_BuildSettlement": case "Base_StartPhase_BuildSettlement": return GamePieceType.Settlement;
            case "Base_BuildCity": return GamePieceType.City;
            case "Base_Robber_Move": return GamePieceType.Robber;
        }
        return null;
    }

    static bool Same(object a, object b)
    {
        var d = new List<string>();
        Diff(null, "", null, null, a, b, "x", 1, d, false);
        return d.Count == 0;
    }

    // Base-game resource cards only, positive amounts.
    static string Base(CardBundleModel b)
    {
        if (b?.Resources == null) return "missing cards";
        foreach (var c in b.Resources)
            if (c.Type != GameCardType.BaseResource || c.BaseRes == null || !Enum.IsDefined(typeof(BaseResourceType), c.BaseRes.Value) || c.Amount <= 0) return "not a resource card: " + c;
        return null;
    }

    static string Owned(Replay r, int seat, CardBundleModel b)
    {
        string why = Base(b);
        if (why != null) return why;
        var players = r.State.CatanGameState.Player;
        if (seat < 0 || seat >= players.Count) return "seat " + seat;
        return players[seat].Inventory.Resources.Contains(b) ? null : $"seat {seat} does not own {string.Join(",", b.Resources.Select(c => c.Amount + "x" + c.BaseRes))}";
    }

    public static string Compare(Replay r, CommonGameActionState recv, CommonGameActionState gen)
    {
        Count++;
        string aid = recv.CommonActionId?.ToSerializedString() ?? "?";
        var diffs = new List<string>();
        Diff(r, aid, recv, gen, recv, gen, "", 0, diffs, true);
        if (Calibrate)
        {
            string tr = Environment.GetEnvironmentVariable("REFEREE_TRACE");
            foreach (var d in diffs)
            {
                string k = aid + "|" + d;
                Seen[k] = Seen.TryGetValue(k, out int n) ? n + 1 : 1;
                if (tr != null && k.Contains(tr)) Console.WriteLine($"  trace uid={recv.UniqueId} p{recv.PlayerId} ai={recv.WasActionPlayedByAI} tt={recv.TurntimerPlayedByPlayerId} sync={recv.NetworkSyncId} ctx={r.State.ContextState.CurrentContextId?.ToReadableString()} next={r.State.ContextState.NextUniqueId} {k}");
            }
            return null;
        }
        return diffs.Count == 0 ? null : diffs[0];
    }

    static void Diff(Replay r, string aid, CommonGameActionState recv, CommonGameActionState gen, object a, object b, string path, int depth, List<string> diffs, bool rules)
    {
        if (depth > 0 && rules)
        {
            if (depth == 1 && Ignore.Contains(path)) return;
            if (IgnoreSuffix.Any(path.EndsWith)) return;
            if (Rules.TryGetValue(aid + "|" + path, out Rule rule) || Rules.TryGetValue(path, out rule))
            {
                if (rule == null) return; // explicitly unchecked
                string why = rule(r, recv, gen, a, b);
                if (why != null) diffs.Add(path + ": " + why);
                return;
            }
        }
        if (a == null && b == null) return;
        if (a == null || b == null) { diffs.Add(path + (a == null ? " missing" : " unexpected") + Show(a, b)); return; }
        Type t = a.GetType();
        if (t != b.GetType()) { diffs.Add(path + " type differs"); return; }
        if (t.IsPrimitive || t.IsEnum || a is string || a is decimal)
        {
            if (!a.Equals(b)) diffs.Add(path + " differs" + Show(a, b));
            return;
        }
        if (depth > 16) return;
        if (a is IList la)
        {
            var lb = (IList)b;
            if (la.Count != lb.Count) { diffs.Add($"{path} count {la.Count} != {lb.Count}"); return; }
            for (int i = 0; i < la.Count; i++) Diff(r, aid, recv, gen, la[i], lb[i], path + "[" + i + "]", depth + 1, diffs, rules);
            return;
        }
        if (a is IDictionary da)
        {
            var db = (IDictionary)b;
            if (da.Count != db.Count) { diffs.Add($"{path} count {da.Count} != {db.Count}"); return; }
            foreach (var k in da.Keys)
            {
                if (!db.Contains(k)) { diffs.Add($"{path}[{k}] unexpected"); return; }
                Diff(r, aid, recv, gen, da[k], db[k], path + "[" + k + "]", depth + 1, diffs, rules);
            }
            return;
        }
        if (a is IEnumerable ea) // sets: compare as sorted multisets of their text form
        {
            var sa = ea.Cast<object>().Select(x => x?.ToString()).OrderBy(x => x).ToList();
            var sb = ((IEnumerable)b).Cast<object>().Select(x => x?.ToString()).OrderBy(x => x).ToList();
            if (!sa.SequenceEqual(sb)) diffs.Add(path + " differs");
            return;
        }
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            if (f.Name == "__isset") continue;
            Diff(r, aid, recv, gen, f.GetValue(a), f.GetValue(b), path.Length == 0 ? f.Name : path + "." + f.Name, depth + 1, diffs, rules);
        }
    }

    static string Show(object a, object b)
    {
        string s(object o) { string x = o?.ToString() ?? "null"; return x.Length > 120 ? x.Substring(0, 120) + ".." : x; }
        return $" (received {s(a)}, generated {s(b)})";
    }
}
