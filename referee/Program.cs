// L3 referee: replays a finished multiplayer match with the game's own rules code (operator's game install, see
// tools/referee-setup.sh) and judges every action. Contract + verdict format: docs/design/level3-referee.md
//   serve  [--game DIR] [--port 8790] [--bind 127.0.0.1]   HTTP: GET /healthz, POST /v1/replay {session, actions[]}
//   replay <request.json> [--game DIR]                      one verdict to stdout
//   selftest <fixtures dir> [--game DIR]                    recorded matches + tampered copies (referee/test/run.sh)
// Needs GLIBC_TUNABLES=glibc.rtld.execstack=2 on newer glibc (Harmony). Game state is static (GameActionMapping,
// HexGridLinks, card id counter, board cache): one replay at a time per process, requests are serialized.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;

static class Program
{
    public static string GameDir;

    static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("usage: Referee serve|replay <file>|selftest <dir> [--game DIR] [--port N] [--bind ADDR]");
            return 2;
        }
        GameDir = Arg(args, "--game") ?? Environment.GetEnvironmentVariable("REFEREE_GAME") ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "game");
        GameDir = Path.GetFullPath(GameDir);
        string managed = Path.Combine(GameDir, "Managed");
        if (!File.Exists(Path.Combine(managed, "Assembly-CSharp.dll")))
        {
            Console.Error.WriteLine($"game files missing in {GameDir} (run tools/referee-setup.sh)");
            return 2;
        }
        // Game assemblies come from the setup output, never from the build output (resolver must exist before any game type is touched).
        AssemblyLoadContext.Default.Resolving += (ctx, name) =>
        {
            string p = Path.Combine(managed, name.Name + ".dll");
            return File.Exists(p) ? ctx.LoadFromAssemblyPath(p) : null;
        };
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(string[] args)
    {
        GameData.Load(GameDir);
        Shims.Install();
        switch (args[0])
        {
            case "serve":
                return Server.Serve(Arg(args, "--bind") ?? Environment.GetEnvironmentVariable("REFEREE_BIND") ?? "127.0.0.1",
                    int.Parse(Arg(args, "--port") ?? Environment.GetEnvironmentVariable("REFEREE_PORT") ?? "8790"));
            case "replay":
                Console.WriteLine(Server.Handle(File.ReadAllText(args[1])).ToJsonString());
                return 0;
            case "selftest":
                return SelfTest.Run(args[1]);
        }
        Console.Error.WriteLine("unknown command " + args[0]);
        return 2;
    }

    static string Arg(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
    }
}
