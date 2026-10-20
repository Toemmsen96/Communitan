using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.Http;
using System.Threading.Tasks;

namespace Communitan
{
    // Async GET <url>/healthcheck off the main thread (+ public player counts for custom servers); the picker polls Get(url) each frame.
    internal static class ServerPing
    {
        internal class Result
        {
            public bool Done;
            public bool Ok;
            public string Text = "pinging...";
            // "5 online · 2 playing · 1 searching[ · server seeds| · server dice][ · free tier| · own purchases]" when the server answers COMMUNITAN_STATUS, else null (Official, older servers).
            public string Counts;
        }

        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
        private static readonly Dictionary<string, Result> results = new Dictionary<string, Result>();

        // statusKey: the server's public status key (ServerEntry.EffectiveStatusKey); null = ping only.
        internal static Result Get(string url, string statusKey = null)
        {
            lock (results)
            {
                string cacheKey = url + "|" + statusKey;
                if (!results.TryGetValue(cacheKey, out Result result))
                {
                    result = new Result();
                    results[cacheKey] = result;
                    Task.Run(() => Run(url, statusKey, result));
                }
                return result;
            }
        }

        internal static void Clear()
        {
            lock (results)
            {
                results.Clear();
            }
        }

        private static async Task Run(string url, string statusKey, Result result)
        {
            Stopwatch watch = Stopwatch.StartNew();
            string text;
            bool ok = false;
            try
            {
                using (HttpResponseMessage response = await http.GetAsync(url.TrimEnd('/') + "/healthcheck").ConfigureAwait(false))
                {
                    ok = response.IsSuccessStatusCode;
                    text = ok ? $"online {watch.ElapsedMilliseconds} ms" : $"HTTP {(int)response.StatusCode}";
                }
            }
            catch (TaskCanceledException)
            {
                text = "timeout";
            }
            catch (Exception e)
            {
                text = "offline";
                Communitan.logger.LogDebug($"Ping {url} failed: {e.GetBaseException().Message}");
            }
            lock (results)
            {
                result.Ok = ok;
                result.Text = text;
                result.Done = true;
            }
            if (ok && statusKey != null)
            {
                ServerStatus status = await FetchStatus(url, statusKey).ConfigureAwait(false);
                if (status != null)
                {
                    lock (results)
                    {
                        result.Counts = $"{status.Online} online · {status.Playing} playing · {status.Searching} searching"
                            + (status.Rng == "full" ? " · server dice" : status.Rng == "seeds" ? " · server seeds" : "")
                            + EntitlementsText(status.Entitlements);
                    }
                }
            }
        }

        // Server CATAN_ENTITLEMENTS (docs/HOSTING.md); older servers send nothing.
        private static string EntitlementsText(string mode) =>
            mode == "owned" ? " · own purchases" : mode == "free" ? " · free tier" : mode == "dev" ? " · everything unlocked (dev)" : "";

        // Public player counts (server RPC COMMUNITAN_STATUS via the runtime http_key, no login; docs/protocol/core.md 5.4).
        // null for servers without it (older versions: 404, other http_key: 401) or on any error.
        internal static async Task<ServerStatus> FetchStatus(string url, string statusKey)
        {
            try
            {
                string uri = $"{url.TrimEnd('/')}/v2/rpc/COMMUNITAN_STATUS?http_key={Uri.EscapeDataString(statusKey)}&unwrap";
                using (HttpResponseMessage response = await http.GetAsync(uri).ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode)
                    {
                        return null;
                    }
                    JObject o = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
                    return o["online"] == null ? null : new ServerStatus(o);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogDebug($"Status {url} failed: {e.GetBaseException().Message}");
                return null;
            }
        }
    }

    internal class ServerStatus
    {
        public readonly int Online, Playing, Searching;
        // Server RNG level (CATAN_SERVER_RNG, docs/design/server-rng.md): "off", "seeds" or "full"; "off" for older servers.
        public readonly string Rng;
        // Paid content (CATAN_ENTITLEMENTS): "free", "owned" (mirrors the player's official purchases, Entitlements.cs) or
        // "dev" (local testing unlock); null for older servers.
        public readonly string Entitlements;
        private readonly JObject modes;

        public ServerStatus(JObject o)
        {
            Online = (int?)o["online"] ?? 0;
            Playing = (int?)o["playing"] ?? 0;
            Searching = (int?)o["searching"] ?? 0;
            Rng = (string)o["rng"] ?? "off";
            Entitlements = (string)o["entitlements"];
            modes = o["modes"] as JObject;
        }

        public int ModeSearching(string modeKey) => (int?)modes?[modeKey]?["searching"] ?? 0;

        public int ModePlaying(string modeKey) => (int?)modes?[modeKey]?["playing"] ?? 0;
    }
}
