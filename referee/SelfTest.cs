// referee/test/run.sh: replays every fixture (recorded real matches, sanitized: referee/test/fixtures/*.json =
// {session, actions[], expect}) and tampered copies of the finished ones; each tampered copy must be "invalid" for the
// tampering player at the forged action. Exit code = number of failures.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using Common.GameLogic.Model;
using Thrift.Utilities;

static class SelfTest
{
    static int fails;
    static void Ok(bool c, string what) { Console.WriteLine((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }

    // name, applies-to (rng off only?), forge: returns the forged action's index or -1 when the match has none
    static readonly (string name, bool offOnly, Func<List<CommonGameActionState>, int> forge)[] Tampers =
    {
        ("costs: free road", false, l => Forge(l, "Base_BuildRoad", a => a.CatanGameActionState.AsResourceCosts.Resources.Clear())),
        ("costs: free city", false, l => Forge(l, "Base_BuildCity", a => a.CatanGameActionState.AsResourceCosts.Resources.Clear())),
        ("position: settlement on an occupied corner", false, l => Forge(l, "Base_BuildSettlement", a =>
            a.CatanGameActionState.AsCandidates.SelectedPosition = l.First(x => Id(x) == "Base_StartPhase_BuildSettlement").CatanGameActionState.AsCandidates.SelectedPosition)),
        ("position: start road elsewhere", false, l => Forge(l, "Base_StartPhase_BuildRoad", a =>
            a.CatanGameActionState.AsCandidates.SelectedPosition = l.Last(x => Id(x) == "Base_BuildRoad").CatanGameActionState.AsCandidates.SelectedPosition)),
        ("trade: offers cards it does not own", false, l => Forge(l, "Trade_FinishTrade", a => a.CatanGameActionState.AsTradeFinish.Offer.Give.Resources[0].Amount = 19)),
        ("bank: 1:1 trade", false, l => Forge(l, "Trade_Bank", a => { var o = a.CatanGameActionState.AsTradeFinish.Offer; o.Give.Resources.ForEach(c => c.Amount = 1); o.Want.Resources.ForEach(c => c.Amount = 1); })),
        ("robber: rob a player not offered", false, l => {
            int k = l.FindIndex(a => Id(a) == "Base_SelectPlayerToRob" && a.CatanGameActionState.AsSelectAblePlayers.PlayersList.Count == 1);
            if (k < 0) return -1;
            var s = a(l[k]).AsSelectAblePlayers;
            s.SelectedPlayer = Enumerable.Range(0, 4).First(p => p != l[k].PlayerId && !s.PlayersList.Contains(p));
            return k; }),
        ("discard: wrong amount", false, l => Forge(l, "Base_Robber_HandOverResourcesToRobber", x => x.CatanGameActionState.AsRobbedResources.ChosenResources.Resources[0].Amount += 1)),
        ("dice: forged roll", true, l => Forge(l, "Base_RollDice", a => { var d = a.CatanGameActionState.AsBaseRollDice.DiceValues; d[0] = d[0] == 6 ? 5 : 6; })),
        ("dev card: chosen card", true, l => Forge(l, "Base_BuyDevelopmentCard", a => {
            var c = a.CatanGameActionState.AsBuyDevelopmentCard.DevelopmentCard;
            c.CardType = c.CardType == Catan.GameLogic.Model.DevelopmentCardType.Victory ? Catan.GameLogic.Model.DevelopmentCardType.Knight : Catan.GameLogic.Model.DevelopmentCardType.Victory; })),
    };

    static string Id(CommonGameActionState a) => a.CommonActionId?.ToSerializedString();
    static Catan.GameLogic.Model.CatanGameActionState a(CommonGameActionState x) => x.CatanGameActionState;

    static int Forge(List<CommonGameActionState> l, string id, Action<CommonGameActionState> f)
    {
        // a later occurrence (index 1 if any): the first one may coincide with a special case (e.g. free start roads)
        var idx = l.Select((a, i) => (a, i)).Where(x => Id(x.a) == id).Select(x => x.i).ToList();
        if (idx.Count == 0) return -1;
        int k = idx[Math.Min(1, idx.Count - 1)];
        f(l[k]);
        return k;
    }

    public static int Run(string dir)
    {
        foreach (string f in Directory.GetFiles(dir, "*.json").OrderBy(x => x))
        {
            string name = Path.GetFileNameWithoutExtension(f);
            var fx = JsonNode.Parse(File.ReadAllText(f)).AsObject();
            var expect = fx["expect"].AsObject();
            var req = new JsonObject { ["session"] = fx["session"].DeepClone(), ["actions"] = fx["actions"].DeepClone() };
            var v = Server.Handle(req.ToJsonString());
            if ((bool)expect["ok"])
            {
                Ok((bool?)v["ok"] == true, $"{name}: ok ({Brief(v)})");
                var want = expect["ranks"].AsObject();
                bool same = v["ranks"].AsArray().All(r => (int?)want[(string)r["playerId"]] == (int)r["rank"]) && v["ranks"].AsArray().Count == want.Count;
                Ok(same, $"{name}: ranks = recorded {want.ToJsonString()} (got {string.Join(",", v["ranks"].AsArray().Select(r => r["playerId"] + ":" + r["rank"] + "/" + r["vp"] + "vp"))})");
            }
            else if (expect["invalid"] is JsonObject inv)
            {
                // recorded real cheat: flagged at exactly this action of this seat
                Ok(v["invalid"] != null && (int?)v["invalid"]["uid"] == (int)inv["uid"] && (int?)v["invalid"]["seat"] == (int)inv["seat"],
                    $"{name}: invalid at uid {inv["uid"]} seat {inv["seat"]} ({Brief(v)})");
                continue;
            }
            else
            {
                Ok(v["invalid"] == null && (bool?)v["ok"] == false, $"{name}: not ok and never invalid ({Brief(v)})");
                continue;
            }
            if (Checks.Calibrate) continue;
            bool off = (string)fx["session"]["rng"] != "full";
            foreach (var t in Tampers)
            {
                if (t.offOnly && !off) continue;
                Serializer.CurrentFormat = Serializer.Format.binary;
                var acts = fx["actions"].AsArray().Select(a => Serializer.LoadAsText<CommonGameActionState>((string)a["a"])).ToList();
                int k = t.forge(acts);
                if (k < 0) continue;
                var arr = fx["actions"].DeepClone().AsArray();
                arr[k]["a"] = Serializer.SaveAsText(acts[k]);
                for (int i = 0; i < arr.Count; i++) arr[i]["by"] = "user-" + Serializer.LoadAsText<CommonGameActionState>((string)arr[i]["a"]).PlayerId; // sender = seat owner
                var tv = Server.Handle(new JsonObject { ["session"] = fx["session"].DeepClone(), ["actions"] = arr }.ToJsonString());
                var inv = tv["invalid"];
                int seat = acts[k].PlayerId ?? -1;
                Ok(inv != null && (int)inv["uid"] == acts[k].UniqueId && (int)inv["seat"] == seat && (string)inv["senderId"] == "user-" + seat,
                    $"{name}: tamper {t.name} uid={acts[k].UniqueId} seat={seat} -> {(inv ?? tv["desync"])?.ToJsonString()}");
            }
        }
        if (Checks.Calibrate)
        {
            Console.WriteLine("calibration: differences between received and generated actions in honest games");
            foreach (var kv in Checks.Seen) Console.WriteLine($"  {kv.Value,5}  {kv.Key}");
        }
        Console.WriteLine(fails == 0 ? "referee selftest: all ok" : $"referee selftest: {fails} failure(s)");
        return fails;
    }

    static string Brief(JsonNode v) =>
        $"applied={v["stats"]?["applied"]} dups={v["stats"]?["dups"]} obsolete={v["stats"]?["obsolete"]} mixes={v["stats"]?["mixes"]} {v["stats"]?["ms"]}ms" +
        (v["invalid"] != null ? " invalid=" + v["invalid"].ToJsonString() : "") + (v["desync"] != null ? " desync=" + v["desync"].ToJsonString() : "") + (v["reason"] != null ? " " + v["reason"] : "");
}
