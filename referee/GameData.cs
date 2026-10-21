// Files written by tools/referee-setup.sh (operator's own game install): rules + scenario TextAssets (base64 Thrift,
// as Resources.Load<TextAsset> returns them in game) and the ScenarioSetup.MapShuffleMode table.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;

static class GameData
{
    public const int BaseGame = 1; // Common.Net/ExpansionsEnum.cs CatanBaseGame
    public static string RulesText;
    static readonly Dictionary<string, string> scenarios = new Dictionary<string, string>();
    static readonly Dictionary<string, (int mode, int[] expansions)> setups = new Dictionary<string, (int, int[])>();

    public static void Load(string gameDir)
    {
        string a = Path.Combine(gameDir, "assets");
        RulesText = File.ReadAllText(Path.Combine(a, "rules", "CatanGameRules.txt"));
        var modes = JsonNode.Parse(File.ReadAllText(Path.Combine(a, "shufflemodes.json"))).AsObject();
        foreach (var kv in modes)
            setups[kv.Key] = ((int)kv.Value["mode"], kv.Value["expansions"].AsArray().Select(x => (int)x).ToArray());
        string dir = Path.Combine(a, "scenarios", "catan");
        if (Directory.Exists(dir))
            foreach (string f in Directory.GetFiles(dir, "*.txt")) scenarios[Path.GetFileNameWithoutExtension(f)] = File.ReadAllText(f);
    }

    // Base-game scenarios the referee can replay (TextAsset + shuffle mode known).
    public static IEnumerable<string> Supported() =>
        scenarios.Keys.Where(k => setups.TryGetValue(k, out var s) && s.expansions.Length == 1 && s.expansions[0] == BaseGame).OrderBy(k => k);

    public static bool TryScenario(string id, out string text, out int shuffleMode)
    {
        text = null;
        shuffleMode = 0;
        if (id == null || !Supported().Contains(id)) return false;
        text = scenarios[id];
        shuffleMode = setups[id].mode;
        return true;
    }
}
