using BepInEx;
using Nakama.Core;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Communitan
{
    public class ServerEntry
    {
        public string Name;
        public string Host;
        public int Port = 7350;
        public string Scheme = "http";
        public string ServerKey = "defaultkey";

        // Guest login with the real (unsalted) device id, so a guest account made before per-server salting stays
        // reachable. Set once for entries that existed before (privacyVersion 1); new entries are salted.
        [JsonProperty(DefaultValueHandling = DefaultValueHandling.Ignore)]
        public bool LegacyDeviceId;

        // Public status key (Nakama runtime.http_key) for the player counts in the server list; null = server default.
        [JsonProperty(DefaultValueHandling = DefaultValueHandling.Ignore)]
        public string StatusKey;

        public const string DefaultStatusKey = "catan-public-status";

        [JsonIgnore]
        public string EffectiveStatusKey => string.IsNullOrEmpty(StatusKey) ? DefaultStatusKey : StatusKey;

        [JsonIgnore]
        public string HostPort => $"{Host}:{Port}".ToLowerInvariant();

        // http to anything but this machine: passwords etc. travel in plain text.
        [JsonIgnore]
        public bool Unencrypted => Scheme != "https" && !IsLoopback(Host);

        public static bool IsLoopback(string host)
        {
            host = (host ?? "").Trim('[', ']').ToLowerInvariant();
            return host == "localhost" || host == "::1" || host.StartsWith("127.");
        }

        [JsonIgnore]
        public string Url => $"{Scheme}://{Host}:{Port}";

        // What the picker shows/edits: "host:port" for http, full URL otherwise.
        [JsonIgnore]
        public string Address => Scheme == "http" ? $"{Host}:{Port}" : Url;

        public override string ToString()
        {
            return $"{Name} ({Url})";
        }

        // Accepts "host", "host:port" or "http(s)://host[:port]"; default scheme http, port 7350.
        public static bool TryParseAddress(string text, out string scheme, out string host, out int port, out string error)
        {
            scheme = "http";
            host = null;
            port = 7350;
            error = null;
            string rest = (text ?? "").Trim().TrimEnd('/');
            int sep = rest.IndexOf("://", StringComparison.Ordinal);
            if (sep >= 0)
            {
                scheme = rest.Substring(0, sep).ToLowerInvariant();
                rest = rest.Substring(sep + 3);
                if (scheme != "http" && scheme != "https")
                {
                    error = "Scheme must be http or https";
                    return false;
                }
            }
            int colon = rest.LastIndexOf(':');
            if (colon >= 0)
            {
                if (!int.TryParse(rest.Substring(colon + 1), out port) || port < 1 || port > 65535)
                {
                    error = "Port must be 1-65535";
                    return false;
                }
                rest = rest.Substring(0, colon);
            }
            if (rest.Length == 0 || rest.IndexOfAny(new[] { ' ', '/', ':', '?', '#', '@' }) >= 0)
            {
                error = "Enter host, host:port or http(s)://host:port";
                return false;
            }
            host = rest;
            return true;
        }
    }

    // Server list persisted as <game>/BepInEx/config/Communitan.servers.json:
    //   {"selected":"<name or 'Official'>","servers":[{Name,Host,Port,Scheme,ServerKey},...]}
    // "Official" is a pseudo-entry mapping to the game's NakamaSettings env (cfg Server.OfficialEnv).
    // UI usage: Servers (edit + Save()), Select(name) to switch, PickerRequired to decide whether to show a picker.
    public static class ServerList
    {
        public const string OfficialName = "Official";

        private class FileModel
        {
            [JsonProperty("selected")]
            public string Selected = "Local";

            [JsonProperty("servers")]
            public List<ServerEntry> Servers = new List<ServerEntry>();

            // Endpoint (scheme://host:port) the game's stored login (user.config) belongs to; set when a NakamaConnection is created.
            [JsonProperty("authEndpoint")]
            public string AuthEndpoint;

            // host:port of custom servers whose "community server" warning the user acknowledged.
            [JsonProperty("acknowledged")]
            public List<string> Acknowledged = new List<string>();

            // 1 = per-server device id salting introduced (pre-existing entries got LegacyDeviceId).
            [JsonProperty("privacyVersion")]
            public int PrivacyVersion;
        }

        private static readonly object fileLock = new object();
        private static FileModel model = new FileModel();
        private static string runtimeSelection;
        private static ServerEntry direct;

        // Name of the one-off "Direct connect" entry (session only, never saved).
        public const string DirectName = "Direct connect";

        // env CATAN_SERVERS: per-instance list for harness runs (tools/run-game.sh --instance N).
        public static string FilePath => string.IsNullOrEmpty(System.Environment.GetEnvironmentVariable("CATAN_SERVERS")) ? Path.Combine(Paths.ConfigPath, "Communitan.servers.json") : System.Environment.GetEnvironmentVariable("CATAN_SERVERS");

        public static List<ServerEntry> Servers => model.Servers;

        // Persisted selection (what the picker saved last).
        public static string SavedSelection => model.Selected;

        // Effective selection for this session: Startup.AutoSelect / Select() override, else the saved one.
        public static string Selected => runtimeSelection ?? model.Selected;

        // True when the UI should ask the user (Startup.ShowPicker and no Startup.AutoSelect).
        public static bool PickerRequired => Communitan.showPicker.Value && string.IsNullOrEmpty(Communitan.autoSelect.Value);

        public static IEnumerable<string> Names => new[] { OfficialName }.Concat(model.Servers.Select(s => s.Name));

        public static string AuthEndpoint => model.AuthEndpoint;

        public static bool IsReservedName(string name)
        {
            return string.Equals(name, OfficialName, StringComparison.OrdinalIgnoreCase) || string.Equals(name, DirectName, StringComparison.OrdinalIgnoreCase);
        }

        public static ServerEntry Find(string name)
        {
            if (direct != null && string.Equals(name, DirectName, StringComparison.OrdinalIgnoreCase))
            {
                return direct;
            }
            return model.Servers.FirstOrDefault(s => string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        public static void Load()
        {
            lock (fileLock)
            {
                try
                {
                    if (File.Exists(FilePath))
                    {
                        model = JsonConvert.DeserializeObject<FileModel>(File.ReadAllText(FilePath)) ?? new FileModel();
                        if (model.Servers == null)
                        {
                            model.Servers = new List<ServerEntry>();
                        }
                        if (model.Acknowledged == null)
                        {
                            model.Acknowledged = new List<string>();
                        }
                        if (model.PrivacyVersion < 1)
                        {
                            MigrateLegacyDeviceIds();
                        }
                        return;
                    }
                }
                catch (Exception e)
                {
                    Communitan.logger.LogError($"Cannot read {FilePath}, using defaults: {e.Message}");
                    model = new FileModel();
                }
                model.Servers.Add(new ServerEntry { Name = "Local", Host = "127.0.0.1", Port = 7350, Scheme = "http", ServerKey = "defaultkey" });
                model.Selected = "Local";
                model.PrivacyVersion = 1;
            }
            Save();
        }

        // Servers joined before salting may hold a guest account under the real device id: keep using it for them.
        private static void MigrateLegacyDeviceIds()
        {
            foreach (ServerEntry entry in model.Servers)
            {
                entry.LegacyDeviceId = true;
            }
            model.PrivacyVersion = 1;
            Communitan.logger.LogInfo($"Privacy: kept the unsalted guest device id for existing servers [{string.Join(", ", model.Servers.Select(s => s.Name))}] (servers.json LegacyDeviceId)");
            Save();
        }

        public static bool IsAcknowledged(ServerEntry entry)
        {
            return model.Acknowledged.Contains(entry.HostPort);
        }

        public static void Acknowledge(ServerEntry entry)
        {
            if (!IsAcknowledged(entry))
            {
                model.Acknowledged.Add(entry.HostPort);
                Save();
            }
        }

        // Custom (non-official) server in effect: privacy hardening applies. /setenv to an official env counts as official.
        public static bool IsCustomSelected => Patches.Patches.EnvOverride == null && CurrentEntry != null;

        // The selected custom entry (or the Direct connect one); null for Official.
        public static ServerEntry CurrentEntry => string.Equals(Selected, OfficialName, StringComparison.OrdinalIgnoreCase) ? null : Find(Selected) ?? model.Servers.FirstOrDefault();

        public static void Save()
        {
            lock (fileLock)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                    string tmp = FilePath + ".tmp";
                    File.WriteAllText(tmp, JsonConvert.SerializeObject(model, Formatting.Indented));
                    if (File.Exists(FilePath))
                    {
                        File.Delete(FilePath);
                    }
                    File.Move(tmp, FilePath);
                }
                catch (Exception e)
                {
                    Communitan.logger.LogError($"Cannot write {FilePath}: {e.Message}");
                }
            }
        }

        // persist=true: remember as the saved selection (picker); false: this session only (AutoSelect).
        public static bool Select(string name, bool persist = true)
        {
            if (!string.Equals(name, OfficialName, StringComparison.OrdinalIgnoreCase) && Find(name) == null)
            {
                Communitan.logger.LogWarning($"Unknown server '{name}'. Known: {string.Join(", ", Names)}");
                return false;
            }
            if (persist)
            {
                model.Selected = name;
                runtimeSelection = null;
                Save();
            }
            else
            {
                runtimeSelection = name;
            }
            return true;
        }

        // One-off server for this session only (picker "Direct connect").
        public static void SelectDirect(ServerEntry entry)
        {
            entry.Name = DirectName;
            direct = entry;
            runtimeSelection = DirectName;
        }

        // Keeps the saved/session selection pointing at an entry after it was renamed in the picker.
        public static void Renamed(string oldName, string newName)
        {
            if (string.Equals(model.Selected, oldName, StringComparison.OrdinalIgnoreCase))
            {
                model.Selected = newName;
            }
            if (string.Equals(runtimeSelection, oldName, StringComparison.OrdinalIgnoreCase))
            {
                runtimeSelection = newName;
            }
        }

        // Called whenever a NakamaConnection is created: the next stored login will belong to this endpoint.
        internal static void RecordAuthEndpoint(string endpoint)
        {
            if (model.AuthEndpoint != endpoint)
            {
                model.AuthEndpoint = endpoint;
                Save();
            }
        }

        public static string Endpoint(NakamaConfig config)
        {
            return $"{config.Scheme}://{config.Host}:{config.Port}";
        }

        internal static NakamaConfig GetOfficialConfig(OfficialEnv env)
        {
            switch (env)
            {
                case OfficialEnv.QA:
                    return NakamaSettings.NakamaConfigQA;
                case OfficialEnv.DEV:
                    return NakamaSettings.NakamaConfigDEV;
                case OfficialEnv.LOCAL:
                    return NakamaSettings.NakamaConfigLOCAL;
                default:
                    return NakamaSettings.NakamaConfigPROD;
            }
        }

        // NakamaConfig for the effective selection; read by the NakamaConnection ctor patch.
        public static NakamaConfig Current
        {
            get
            {
                string name = Selected;
                if (string.Equals(name, OfficialName, StringComparison.OrdinalIgnoreCase))
                {
                    return GetOfficialConfig(Communitan.officialEnv.Value);
                }
                ServerEntry entry = Find(name) ?? model.Servers.FirstOrDefault();
                if (entry == null)
                {
                    Communitan.logger.LogWarning("Server list empty, falling back to Official");
                    return GetOfficialConfig(Communitan.officialEnv.Value);
                }
                return new NakamaConfig(entry.Scheme, entry.Host, entry.Port, entry.ServerKey);
            }
        }
    }
}
