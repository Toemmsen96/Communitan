// HTTP front of the referee (HttpListener: no ASP.NET runtime needed). Requests are handled strictly one at a time
// (static game state); a replay that hangs past the watchdog ends the process (compose restarts it). Future: worker pool.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;

static class Server
{
    const int MaxBody = 64 << 20;
    static readonly TimeSpan Watchdog = TimeSpan.FromSeconds(int.TryParse(Environment.GetEnvironmentVariable("REFEREE_WATCHDOG_SEC"), out int s) ? s : 60);
    static int served;

    public static int Serve(string bind, int port)
    {
        var l = new HttpListener();
        // HttpListener prefixes match the Host header (container clients use other names): listen on all interfaces,
        // and with a loopback --bind answer loopback clients only.
        bool loopOnly = bind == "127.0.0.1" || bind == "localhost";
        l.Prefixes.Add($"http://*:{port}/");
        l.Start();
        Console.WriteLine($"referee: listening on port {port}{(loopOnly ? " (loopback clients only)" : "")}, game {Program.GameDir}, base-game scenarios: {string.Join(",", GameData.Supported())}");
        for (;;)
        {
            HttpListenerContext ctx = l.GetContext();
            try
            {
                if (loopOnly && !IPAddress.IsLoopback(ctx.Request.RemoteEndPoint.Address)) Write(ctx, 403, new JsonObject { ["error"] = "loopback clients only (use --bind 0.0.0.0)" });
                else Dispatch(ctx);
            }
            catch (Exception e) { Console.WriteLine("referee: request failed: " + e.Message); }
            finally { try { ctx.Response.Close(); } catch { } }
        }
    }

    static void Dispatch(HttpListenerContext ctx)
    {
        string path = ctx.Request.Url.AbsolutePath;
        if (ctx.Request.HttpMethod == "GET" && path == "/healthz")
        {
            Write(ctx, 200, new JsonObject { ["ok"] = true, ["served"] = served, ["scenarios"] = new JsonArray(GameData.Supported().Select(x => (JsonNode)x).ToArray()) });
            return;
        }
        if (ctx.Request.HttpMethod == "POST" && path == "/v1/replay")
        {
            if (ctx.Request.ContentLength64 > MaxBody) { Write(ctx, 413, new JsonObject { ["error"] = "too large" }); return; }
            string body;
            using (var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = r.ReadToEnd();
            JsonObject v = Guarded(body);
            Write(ctx, v.ContainsKey("error") ? 400 : 200, v);
            return;
        }
        Write(ctx, 404, new JsonObject { ["error"] = "not found" });
    }

    // Runs the replay on its own thread; past the watchdog the process exits after answering (state may be corrupt).
    static JsonObject Guarded(string body)
    {
        JsonObject result = null;
        var t = new Thread(() => result = Handle(body), 64 << 20) { IsBackground = true };
        t.Start();
        if (t.Join(Watchdog)) return result;
        Console.WriteLine("referee: watchdog expired, exiting");
        new Thread(() => { Thread.Sleep(500); Environment.Exit(3); }).Start();
        return new JsonObject { ["error"] = "timeout" };
    }

    public static JsonObject Handle(string body)
    {
        var sw = Stopwatch.StartNew();
        JsonObject req;
        try { req = JsonNode.Parse(body) as JsonObject; }
        catch (Exception e) { return new JsonObject { ["error"] = "bad json: " + e.Message }; }
        if (req == null || !(req["session"] is JsonObject) || !(req["actions"] is JsonArray)) return new JsonObject { ["error"] = "expected {session, actions[]}" };
        JsonObject v;
        try { v = new Replay(req).Run(); }
        catch (Exception e)
        {
            while (e is System.Reflection.TargetInvocationException && e.InnerException != null) e = e.InnerException;
            v = new JsonObject { ["error"] = "replay failed: " + e.GetType().Name + ": " + e.Message };
            Console.WriteLine("referee: " + e);
        }
        served++;
        string id = (string)req["session"]["id"] ?? "?";
        Console.WriteLine($"referee: {id} -> supported={v["supported"]} ok={v["ok"]} {(v["invalid"] ?? v["desync"] ?? v["reason"] ?? v["error"])?.ToJsonString()} ({sw.ElapsedMilliseconds} ms)");
        return v;
    }

    static void Write(HttpListenerContext ctx, int code, JsonObject o)
    {
        byte[] b = Encoding.UTF8.GetBytes(o.ToJsonString());
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = "application/json";
        ctx.Response.ContentLength64 = b.Length;
        ctx.Response.OutputStream.Write(b, 0, b.Length);
    }
}
