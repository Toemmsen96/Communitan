using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using System.Collections;
using System.IO;
using UnityEngine;

namespace Communitan
{
    public enum OfficialEnv { PROD, QA, DEV, LOCAL }
    public enum AutoConnectMode { Off, Connect, DeviceLogin }

    [BepInPlugin(modGUID, modName, modVersion)]
    public class Communitan : BaseUnityPlugin
    {
        private const string modGUID = "Toemmsen96.Communitan";
        private const string modName = "Communitan";
        private const string modVersion = "0.1.0";
        internal static string Version => modVersion;
        private readonly Harmony harmony = new Harmony(modGUID);
        private static Communitan instance;
        internal static MonoBehaviour instanceRef => instance;
        internal static ManualLogSource logger = BepInEx.Logging.Logger.CreateLogSource(modGUID);

        internal static ConfigEntry<OfficialEnv> officialEnv;
        internal static ConfigEntry<bool> showPicker;
        internal static ConfigEntry<string> autoSelect;
        internal static ConfigEntry<bool> trafficLog;
        internal static ConfigEntry<AutoConnectMode> autoConnect;
        internal static ConfigEntry<AutoPlayMode> autoPlay;
        internal static ConfigEntry<string> deviceIdOverride;
        internal static ConfigEntry<float> autoPlayTimeScale;
        internal static ConfigEntry<int> autoPlayPlayers;
        internal static ConfigEntry<string> autoPlayExpansion;
        internal static ConfigEntry<string> autoPlayGameMode;
        internal static ConfigEntry<bool> autoPlayUi;
        internal static ConfigEntry<bool> unityLog;
        internal static ConfigEntry<bool> blockAnalytics;
        internal static ConfigEntry<bool> showServerInfo;

        private void Awake()
        {
            if (instance == null)
            {
                instance = this;
            }
            MigrateLegacyFiles();
            // Harness instances (tools/run-game.sh --instance N) use their own cfg/server list/traffic/log files via env.
            ConfigFile cfg = Config;
            string cfgPath = System.Environment.GetEnvironmentVariable("CATAN_CFG");
            if (!string.IsNullOrEmpty(cfgPath))
            {
                cfg = new ConfigFile(cfgPath, true);
            }
            string extraLog = System.Environment.GetEnvironmentVariable("CATAN_LOG");
            if (!string.IsNullOrEmpty(extraLog))
            {
                BepInEx.Logging.Logger.Listeners.Add(new FileLogListener(extraLog));
            }
            officialEnv = cfg.Bind("Server", "OfficialEnv", OfficialEnv.PROD, "Built-in environment used by the 'Official' server entry");
            showPicker = cfg.Bind("Startup", "ShowPicker", true, "Show the server picker at startup (skipped when Startup.AutoSelect is set)");
            autoSelect = cfg.Bind("Startup", "AutoSelect", "", "Server name (or 'Official') to use this session without asking; empty = saved selection from Communitan.servers.json");
            trafficLog = cfg.Bind("Debug", "TrafficLog", false, "Append Nakama traffic (your ids, messages; passwords masked) as JSON lines to BepInEx/traffic.jsonl. env CATAN_TRAFFIC_LOG=1 forces it on (tools/run-game.sh)");
            showServerInfo = cfg.Bind("UI", "ShowServerInfo", true, "Show the Communitan version and the current server at the top of the screen");
            blockAnalytics = cfg.Bind("Privacy", "BlockAnalytics", true, "While a custom server is selected: drop GameAnalytics events (gameanalytics.com), switch off Unity Analytics / performance reporting and skip Unity Gaming Services init. Never affects the official servers");
            autoConnect = cfg.Bind("Debug", "AutoConnect", AutoConnectMode.Off, "Harness: once the main menu is up, Connect = start Nakama without login; DeviceLogin = also log in as device/guest (creates an account on the selected server!)");
            autoPlay = cfg.Bind("Debug", "AutoPlay", AutoPlayMode.Off, "Harness: QuickMatch = 2-player base-game free match, AutoMatch = 2-player base-game auto (ranked) match, from the main menu; the game's AI plays the local seat (implies AutoConnect=DeviceLogin). HostLobby/JoinLobby: not implemented yet");
            deviceIdOverride = cfg.Bind("Debug", "DeviceIdOverride", "", "Harness: replaces SystemInfo.deviceUniqueIdentifier (guest login id) so several instances get distinct accounts; env CATAN_DEVICE_ID wins");
            autoPlayPlayers = cfg.Bind("Debug", "AutoPlayPlayers", 0, "Harness: exact player count the bot searches for (0 = the game's default for that mode; base-game quick match = 3)");
            autoPlayExpansion = cfg.Bind("Debug", "AutoPlayExpansion", "CatanBaseGame", "Harness: expansion of the QuickMatch/AutoMatch the bot searches (ExpansionsEnum name, e.g. CatanCitiesAndKnights, CatanSeafarer)");
            autoPlayGameMode = cfg.Bind("Debug", "AutoPlayMode", "", "Harness: custom server game mode id (server/data/modes) the QuickMatch bot queues for, e.g. robbers; empty = normal Free Play");
            autoPlayUi = cfg.Bind("Debug", "AutoPlayUi", false, "Harness: with AutoPlayMode, start the mode game through the menu UI (Free Play mode box; HostLobby: the lobby's Game mode selector) instead of setting it directly");
            autoPlayTimeScale = cfg.Bind("Debug", "AutoPlayTimeScale", 1f, "Harness: Time.timeScale while AutoPlay is on (speeds up animations and AI delays)");
            unityLog = cfg.Bind("Debug", "UnityLog", false, "Keep the game's Debug.Log output enabled (production builds switch it off); goes to Player.log");
            Harness.Init();

            ServerList.Load();
            if (ServerList.AuthEndpoint == null)
            {
                // First run with auth tracking: assume the stored login (if any) matches the saved selection.
                ServerList.RecordAuthEndpoint(ServerList.Endpoint(ServerList.Current));
            }
            if (!string.IsNullOrEmpty(autoSelect.Value))
            {
                ServerList.Select(autoSelect.Value, persist: false);
            }

            harmony.PatchAll(typeof(Patches.Patches));
            harmony.PatchAll(typeof(ServerSwitch));
            harmony.PatchAll(typeof(NativeServerScreen));
            harmony.PatchAll(typeof(Harness));
            Privacy.Patch(harmony);
            harmony.PatchAll(typeof(LoginHints));
            harmony.PatchAll(typeof(RegisterFlow));
            harmony.PatchAll(typeof(MailFilter));
            ServerRng.Patch(harmony);
            GameModes.Patch(harmony);
            harmony.PatchAll(typeof(Entitlements));
            harmony.PatchAll(typeof(GameLogicWait));
            harmony.PatchAll(typeof(ScenarioSync));
            harmony.PatchAll(typeof(KickReasonText));
            // Startup picker: holds back the game's login until a server is chosen. Never in -batchmode (headless harness).
            bool pickAtStartup = ServerList.PickerRequired && !Application.isBatchMode;
            ServerSwitch.StartupPending = pickAtStartup;
            if (!pickAtStartup)
            {
                ServerSwitch.ClearStaleAuth();
            }
            if (Application.isBatchMode)
            {
                logger.LogInfo($"Batchmode: server picker disabled, using {ServerList.Selected}");
            }
            else
            {
                ServerPicker.Create(gameObject, pickAtStartup);
            }
            gameObject.AddComponent<MatchmakingStatus>();
            gameObject.AddComponent<ServerInfoOverlay>();
            gameObject.AddComponent<GameModesUi>();
            gameObject.AddComponent<RejoinCancel>();
            gameObject.AddComponent<KickReasonText>();
            gameObject.AddComponent<Entitlements>();
            bool trafficOn = trafficLog.Value || System.Environment.GetEnvironmentVariable("CATAN_TRAFFIC_LOG") == "1";
            if (trafficOn)
            {
                string traffic = System.Environment.GetEnvironmentVariable("CATAN_TRAFFIC");
                TrafficLogger.Open(string.IsNullOrEmpty(traffic) ? Path.Combine(Paths.BepInExRootPath, "traffic.jsonl") : traffic);
                harmony.PatchAll(typeof(Patches.TrafficPatches));
                harmony.PatchAll(typeof(Patches.AuthPatches));
            }
            logger.LogInfo("Communitan loaded. " + NativeServerScreen.Disclaimer);
            logger.LogInfo($"Config: Server={ServerList.Selected} (saved={ServerList.SavedSelection}, AutoSelect='{autoSelect.Value}', ShowPicker={showPicker.Value}, PickerRequired={ServerList.PickerRequired}) OfficialEnv={officialEnv.Value} Servers=[{string.Join(", ", ServerList.Servers)}] TrafficLog={trafficOn} BlockAnalytics={blockAnalytics.Value} AutoConnect={autoConnect.Value} AutoPlay={autoPlay.Value} cfg={cfg.ConfigFilePath} list={ServerList.FilePath}");
            Harness.Start(this);
        }

        // One-time migration from the mod's former name (CatanCustomServers): copy the old cfg, server list and
        // entitlements record to the new names if the new file is missing. The old files are left in place.
        // Skipped for harness instances (CATAN_CFG / CATAN_SERVERS point at their own files).
        private void MigrateLegacyFiles()
        {
            if (string.IsNullOrEmpty(System.Environment.GetEnvironmentVariable("CATAN_CFG"))
                && MigrateFile(Path.Combine(Paths.ConfigPath, "Toemmsen96.CatanCustomServers.cfg"), Config.ConfigFilePath))
            {
                Config.Reload(); // BepInEx loaded the (then missing) new cfg before Awake
            }
            if (string.IsNullOrEmpty(System.Environment.GetEnvironmentVariable("CATAN_SERVERS")))
            {
                MigrateFile(Path.Combine(Paths.ConfigPath, "CatanCustomServers.servers.json"), ServerList.FilePath);
                MigrateFile(Path.Combine(Paths.ConfigPath, "CatanCustomServers.entitlements.json"), Entitlements.FilePath);
            }
        }

        private static bool MigrateFile(string oldPath, string newPath)
        {
            try
            {
                if (File.Exists(newPath) || !File.Exists(oldPath))
                {
                    return false;
                }
                File.Copy(oldPath, newPath);
                logger.LogInfo($"Migrated {Path.GetFileName(oldPath)} -> {Path.GetFileName(newPath)} (old file kept; it can be deleted)");
                return true;
            }
            catch (System.Exception e)
            {
                logger.LogWarning($"Cannot migrate {oldPath} -> {newPath}: {e.Message}");
                return false;
            }
        }

        // AutoPlay needs a login; it implies DeviceLogin without persisting it to the cfg.
        internal static AutoConnectMode EffectiveAutoConnect => autoConnect.Value == AutoConnectMode.Off && autoPlay.Value != AutoPlayMode.Off ? AutoConnectMode.DeviceLogin : autoConnect.Value;

        internal static void StartAutoConnect()
        {
            if (EffectiveAutoConnect != AutoConnectMode.Off && instance != null)
            {
                instance.StartCoroutine(AutoConnectWhenReady());
            }
        }

        private static IEnumerator AutoConnectWhenReady()
        {
            while (ServerSwitch.StartupPending || Common.Net.CommonNetworking.Instance == null || Common.Net.CommonNetworking.Instance.NakamaConnector == null)
            {
                yield return new WaitForSeconds(1f);
            }
            yield return new WaitForSeconds(3f);
            if (EffectiveAutoConnect == AutoConnectMode.DeviceLogin)
            {
                // A stored login makes the game re-login by itself; a second login racing it breaks the client
                // (durable queue stays paused). Only log in as device/guest if the game does not.
                var auth = Common.Net.CommonNetworking.Instance.Authentication;
                bool stored = Common.Net.AuthenticationDetailsSerializer.LocalAuthenticationExists();
                for (int i = 0; i < 20 && stored && !auth.IsAuthenticated; i++)
                {
                    yield return new WaitForSeconds(1f);
                }
                if (auth.IsAuthenticated)
                {
                    logger.LogInfo("Debug.AutoConnect: game re-logged in with its stored login; no device login");
                    Harness.LoginDone = true;
                    yield break;
                }
            }
            logger.LogInfo($"Debug.AutoConnect={EffectiveAutoConnect}: starting Nakama connection");
            if (EffectiveAutoConnect == AutoConnectMode.DeviceLogin)
            {
                Common.Net.CommonNetworking.Instance.NakamaConnector.StartGSConnectionDeviceLogin(response =>
                {
                    logger.LogInfo($"Debug.AutoConnect: device login hasError={response?.HasError()}");
                    Harness.LoginDone = response != null && !response.HasError();
                });
            }
            else
            {
                Common.Net.CommonNetworking.Instance.NakamaConnector.StartGameSparks(ready => logger.LogInfo($"Debug.AutoConnect: NakamaHandler ready={ready}"));
            }
        }

        private void OnDestroy()
        {
            harmony.UnpatchSelf();
            TrafficLogger.Close();
        }
    }
}
