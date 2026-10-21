using BepInEx.Logging;
using Catan.GameLogic.Utilities;
using Common;
using Common.GameLogic.Controllers;
using Common.GameLogic.Model;
using Common.GameLogic.Unity;
using Common.Net;
using Common.Unity;
using Common.Unity.Utilities;
using GameHub.Controllers;
using GameSparks.Platforms;
using HarmonyLib;
using System;
using System.Collections;
using System.IO;
using UnityEngine;

namespace Communitan
{
    public enum AutoPlayMode { Off, QuickMatch, AutoMatch, HostLobby, JoinLobby }

    // Test harness for running several headless clients against our own server (tools/mp-smoke.sh):
    // per-instance device id, a game-AI controller for the local seat, and a menu driver that starts a match.
    // KeepCallbackInvoker (always on) works around two client bugs that break any custom server.
    internal static class Harness
    {
        internal static string DeviceIdOverride;
        private static bool matchStarted;

        internal static AutoPlayMode Mode => Communitan.autoPlay?.Value ?? AutoPlayMode.Off;

        internal static void Init()
        {
            string env = Environment.GetEnvironmentVariable("CATAN_DEVICE_ID");
            DeviceIdOverride = !string.IsNullOrEmpty(env) ? env : Communitan.deviceIdOverride.Value;
            if (string.IsNullOrEmpty(DeviceIdOverride))
            {
                DeviceIdOverride = null;
            }
            else
            {
                Communitan.logger.LogInfo($"Harness: device id override '{DeviceIdOverride}'");
            }
        }

        // ---- device id ----
        [HarmonyPatch(typeof(PlatformBase), "get_DeviceId")]
        [HarmonyPostfix]
        private static void OverridePlatformDeviceId(ref string __result)
        {
            if (DeviceIdOverride != null)
            {
                __result = DeviceIdOverride;
            }
        }

        [HarmonyPatch(typeof(SystemInfo), "get_deviceUniqueIdentifier")]
        [HarmonyPostfix]
        private static void OverrideSystemDeviceId(ref string __result)
        {
            if (DeviceIdOverride != null)
            {
                __result = DeviceIdOverride;
            }
        }

        // The game disables Debug.Log in production builds; the harness wants it in Player.log.
        [HarmonyPatch(typeof(CommonNetworking), "OnEnable")]
        [HarmonyPostfix]
        private static void EnableUnityLog()
        {
            if (Communitan.unityLog.Value)
            {
                Debug.unityLogger.logEnabled = true;
            }
        }

        // ---- AI for the local seat ----
        // AutoPilot's (compiled-out) AutoPlay path: DelayedHybridPlayerController = UI controller + CatanAIPlayerController
        // that answers every action request of the local player.
        [HarmonyPatch(typeof(UnityPlayerController), nameof(UnityPlayerController.CreateAndSetDelayedPlayerController))]
        [HarmonyPrefix]
        private static bool UseHybridController(UnityPlayerController __instance, CommonGameState gameState, ref PlayerController __result)
        {
            if (Mode == AutoPlayMode.Off || CommonNetworking.Instance.MatchConnecting.GameInfo.IsLocalPlayerSpectator
                || gameState.CatanGameState == null || CatanGameUtils.IsBigGame(gameState.CatanGameState))
            {
                return true;
            }
            DelayedPlayerController controller = new DelayedHybridPlayerController();
            AccessTools.Property(typeof(UnityPlayerController), nameof(UnityPlayerController.PlayerController)).SetValue(__instance, controller, null);
            __result = controller;
            Communitan.logger.LogInfo("Milestone: AutoPlay AI controller attached to the local seat");
            return false;
        }

        // ---- client fix: push dispatcher ----
        // Pushes arrive on the Nakama socket thread (NewSocket() without main-thread dispatch); NakamaInstance.ProcessMessage
        // calls NakamaCallbackInvoker.Instance(), which creates its GameObject lazily -> throws off the main thread
        // (silently, the push is lost) unless something created it on the main thread before. Its GameObject is not
        // DontDestroyOnLoad either, so a scene change destroys it again. Keep one alive from the main thread.
        // Also: NakamaInstance.SetUserId saves+restores durableQueuePaused around an async main-thread callback, so two
        // logins in quick succession (auto re-login + a second login) can leave the durable queue paused for good:
        // every durable request (MatchmakingRequest, SEASON_*, ...) then waits forever. Unpause it if that happens.
        internal static IEnumerator KeepCallbackInvoker()
        {
            var field = AccessTools.Field(typeof(NakamaCallbackInvoker), "_instance");
            var paused = AccessTools.Field(typeof(Nakama.Core.NakamaInstance), "durableQueuePaused");
            var handler = AccessTools.Field(typeof(NakamaHandler), "_instance");
            float pausedSince = -1f;
            while (true)
            {
                Nakama.Core.NakamaInstance gs = handler.GetValue(null) as Nakama.Core.NakamaInstance;
                if (gs != null && (bool)paused.GetValue(gs) && CommonNetworking.Instance?.Authentication != null && CommonNetworking.Instance.Authentication.IsAuthenticated)
                {
                    if (pausedSince < 0f)
                    {
                        pausedSince = Time.realtimeSinceStartup;
                    }
                    else if (Time.realtimeSinceStartup - pausedSince > 5f)
                    {
                        Communitan.logger.LogWarning("Durable request queue stuck paused after login (SetUserId race): unpausing");
                        paused.SetValue(gs, false);
                        pausedSince = -1f;
                    }
                }
                else
                {
                    pausedSince = -1f;
                }
                if ((field.GetValue(null) as NakamaCallbackInvoker) == null)
                {
                    GameObject go = new GameObject("NakamaCallbackInvoker");
                    UnityEngine.Object.DontDestroyOnLoad(go);
                    field.SetValue(null, go.AddComponent<NakamaCallbackInvoker>());
                }
                yield return null;
            }
        }

        // ---- menu driver ----
        internal static void Start(MonoBehaviour host)
        {
            host.StartCoroutine(KeepCallbackInvoker());
            if (Mode != AutoPlayMode.Off)
            {
                host.StartCoroutine(Drive());
            }
        }

        private static float nameRequestedAt = -1f;
        internal static bool LoginDone;
        private static string lastWait;

        internal static string MenuWaitPublic() => MenuWait();

        internal static void ShotLater(string name, float seconds)
        {
            if (Environment.GetEnvironmentVariable("CATAN_SHOTS") == "1" && Communitan.instanceRef != null)
            {
                Communitan.instanceRef.StartCoroutine(ShotAfter(name, seconds));
            }
        }

        private static IEnumerator ShotAfter(string name, float seconds)
        {
            yield return new WaitForSecondsRealtime(seconds);
            Shot(name);
        }

        // Harness screenshot (env CATAN_SHOTS=1, needs a rendering run: HEADLESS_METHOD=gamescope) into the instance run dir.
        internal static void Shot(string name)
        {
            if (Environment.GetEnvironmentVariable("CATAN_SHOTS") != "1")
            {
                return;
            }
            try
            {
                // the server's welcome popup would cover everything
                UiRework.PopupManager pm = SceneHelper.IsInMainMenu ? UnityEngine.Object.FindObjectOfType<UiRework.PopupManager>() : null;
                GameObject news = pm != null && pm.scrollableDialogBox != null ? pm.scrollableDialogBox.gameObject : null;
                if (news != null && news.activeSelf)
                {
                    news.SetActive(false);
                }
                string dir = Path.GetDirectoryName(Environment.GetEnvironmentVariable("CATAN_LOG") ?? "") ?? "";
                string path = Path.Combine(dir, $"shot-{DateTime.Now:HHmmss}-{name}.png");
                Type t = Type.GetType("UnityEngine.ScreenCapture, UnityEngine.ScreenCaptureModule");
                t?.GetMethod("CaptureScreenshot", new[] { typeof(string) })?.Invoke(null, new object[] { path });
                Communitan.logger.LogInfo($"Harness: screenshot {path}");
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Harness: screenshot failed: {e}");
            }
        }

        // null = ready; else what we are waiting for.
        private static string MenuWait()
        {
            CommonNetworking net = CommonNetworking.Instance;
            if (net == null || net.Connection == null || !net.Connection.IsConnected) return "connection";
            if (!SceneHelper.IsInMainMenu) return "main menu scene";
            if (!LoginDone || !net.Authentication.IsAuthenticated || net.LocalPlayer?.Details == null || string.IsNullOrEmpty(net.LocalPlayer.Details.Id)) return "login";
            if (UnityGameBase.Game.Instance.sceneTransition.IsInTransition) return "scene transition";
            if (MonoBehaviourSingleton<WaitForMultiplayerGameController>.Instance == null || ScenarioSetupCollection.Instance == null) return "menu controllers";
            if (string.IsNullOrEmpty(net.LocalPlayer.Details.Name))
            {
                // Fresh guest accounts have no display name; the game's rejoin check and matchmaking UI require one.
                if (nameRequestedAt < 0f || Time.realtimeSinceStartup - nameRequestedAt > 20f)
                {
                    nameRequestedAt = Time.realtimeSinceStartup;
                    string name = Environment.GetEnvironmentVariable("CATAN_PLAYER_NAME");
                    if (string.IsNullOrEmpty(name))
                    {
                        string id = DeviceIdOverride ?? net.LocalPlayer.Details.Id;
                        name = "Bot" + new string(Array.FindAll(id.ToCharArray(), char.IsLetterOrDigit)).Substring(Math.Max(0, Array.FindAll(id.ToCharArray(), char.IsLetterOrDigit).Length - 6));
                    }
                    Communitan.logger.LogInfo($"Harness: setting display name '{name}'");
                    net.NakamaSender.SendSetDisplayName(name, err =>
                    {
                        Communitan.logger.LogInfo($"Harness: set display name -> {err}");
                        if (err == ErrorCode.None)
                        {
                            CommonNetworking.Instance.LocalPlayer.Details.Name = name;
                        }
                    });
                }
                return "display name";
            }
            return null;
        }

        private static IEnumerator Drive()
        {
            ManualLogSource log = Communitan.logger;
            log.LogInfo($"Harness: AutoPlay={Mode}, waiting for main menu + login");
            float idleSince = -1f;
            bool hooked = false;
            while (true)
            {
                yield return new WaitForSeconds(1f);
                CommonNetworking net = CommonNetworking.Instance;
                if (net == null || net.MatchConnecting == null)
                {
                    continue;
                }
                if (!hooked)
                {
                    hooked = true;
                    net.MatchConnecting.OnGameStarted += _ =>
                    {
                        log.LogInfo("Milestone: AutoPlay game started");
                        ShotLater("ingame", 25f);
                    };
                    net.MatchConnecting.OnError += s => log.LogWarning($"Harness: MatchConnecting error in state {s}");
                }
                float scale = Communitan.autoPlayTimeScale.Value;
                if (scale > 0f && scale != 1f && SceneHelper.IsInGame && Time.timeScale != scale)
                {
                    Time.timeScale = scale;
                }
                string wait = MenuWait() ?? (net.MatchConnecting.State != MatchState.Idle ? "match state " + net.MatchConnecting.State : null);
                if (wait != lastWait)
                {
                    lastWait = wait;
                    log.LogInfo($"Harness: waiting for {wait ?? "nothing (ready)"}");
                }
                if (wait != null || matchStarted)
                {
                    idleSince = -1f;
                    continue;
                }
                // Idle in the main menu: give the game's own rejoin check (MatchReconnectHandler) time to find a running session.
                if (idleSince < 0f)
                {
                    idleSince = Time.realtimeSinceStartup;
                    log.LogInfo($"Harness: main menu idle as {net.LocalPlayer.Details.Name} ({net.LocalPlayer.Details.Id})");
                }
                if (Time.realtimeSinceStartup - idleSince < 8f)
                {
                    continue;
                }
                if (Mode == AutoPlayMode.QuickMatch)
                {
                    matchStarted = StartQuickMatch();
                }
                else if (Mode == AutoPlayMode.AutoMatch)
                {
                    matchStarted = StartAutoMatch();
                }
                else if (Mode == AutoPlayMode.HostLobby)
                {
                    matchStarted = true;
                    Communitan.instanceRef.StartCoroutine(HostLobby());
                }
                else
                {
                    matchStarted = true;
                    JoinLobby();
                }
            }
        }

        // ---- custom lobby (HostLobby / JoinLobby) ----
        // Rendezvous: the joiner writes its user id to env CATAN_INVITE_FILE; the host invites that id (or env CATAN_INVITE_ID).
        private static string InviteFile => Environment.GetEnvironmentVariable("CATAN_INVITE_FILE");

        private static UiRework.CustomMatch.CustomMatchManager Manager => UnityEngine.Object.FindObjectOfType<UiRework.CustomMatch.CustomMatchManager>(true);

        private static IEnumerator HostLobby()
        {
            ManualLogSource log = Communitan.logger;
            Lobby lobby = CommonNetworking.Instance.Lobby;
            UiRework.CustomMatch.CustomMatchManager mgr = Manager;
            if (mgr == null)
            {
                log.LogError("Harness: CustomMatchManager not found");
                yield break;
            }
            bool? created = null;
            mgr.CreateCustomMatchIfNotAlreadyDone(ok => created = ok);
            while (created == null)
            {
                yield return null;
            }
            MultiplayerGameInformation gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            log.LogInfo($"Milestone: AutoPlay lobby created ok={created} lobby={lobby.LobbyId} scenario={string.Join(",", new System.Collections.Generic.List<string>(gi.SelectedScenarios).ToArray())}");
            if (created != true)
            {
                yield break;
            }
            string mode = Communitan.autoPlayGameMode.Value?.Trim();
            if (!string.IsNullOrEmpty(mode))
            {
                // game mode of the lobby: the host's selector in the scenario settings (GameModesUi), or directly
                bool? picked = null;
                if (Communitan.autoPlayUi.Value)
                {
                    yield return Communitan.instanceRef.StartCoroutine(GameModesUi.HarnessPickLobbyMode(mode, ok => picked = ok));
                }
                else
                {
                    GameModes.SetQueued(gi, mode);
                    lobby.UpdateGameInfo(() => picked = true);
                    while (picked == null)
                    {
                        yield return null;
                    }
                }
                gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
                log.LogInfo($"Milestone: AutoPlay lobby mode {mode} picked={picked} ({(Communitan.autoPlayUi.Value ? "selector" : "direct")}), game info mode={GameModes.QueuedMode(gi) ?? "-"}");
                if (picked != true)
                {
                    yield break;
                }
            }
            string inviteId = Environment.GetEnvironmentVariable("CATAN_INVITE_ID");
            while (string.IsNullOrEmpty(inviteId))
            {
                yield return new WaitForSeconds(1f);
                try
                {
                    if (!string.IsNullOrEmpty(InviteFile) && File.Exists(InviteFile))
                    {
                        inviteId = File.ReadAllText(InviteFile).Trim();
                    }
                }
                catch (IOException)
                {
                }
            }
            gi.MinPlayers = 2;
            gi.MaxPlayers = 2;
            var players = new System.Collections.Generic.List<PlayerDetails> { CommonNetworking.Instance.LocalPlayer.Details, new PlayerDetails { Id = inviteId, Name = inviteId, Index = 1 } };
            bool? invited = null;
            lobby.InvitePlayer(players[1], players, ok => invited = ok);
            while (invited == null)
            {
                yield return null;
            }
            log.LogInfo($"Milestone: AutoPlay invited {inviteId} ok={invited}");
            lobby.SetPlayerIsReady(true);
            float t0 = Time.realtimeSinceStartup;
            while (!(lobby.PlayersInLobby.Exists(p => p.Id == inviteId) && lobby.AreAllPlayersReady()))
            {
                if (Time.realtimeSinceStartup - t0 > 180f)
                {
                    log.LogError($"Harness: invitee did not join+ready in time (inLobby={lobby.PlayersInLobby.Count} ready={lobby.PlayerIdsReady?.Count})");
                    yield break;
                }
                yield return new WaitForSeconds(1f);
            }
            log.LogInfo("Harness: all lobby players ready, starting");
            bool? started = null;
            lobby.StartGame(ok => started = ok);
            while (started == null)
            {
                yield return null;
            }
            log.LogInfo($"Milestone: AutoPlay lobby start ok={started}");
            if (started != true)
            {
                yield break;
            }
            // Same as the custom match screen's start button (BaseCustomMatchState.HandleStartGameButtonClickEvent).
            gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            gi.SortAndAddPlayerDetails(lobby.AllPlayers);
            Action onSetup = null;
            onSetup = () =>
            {
                CommonNetworking.Instance.MatchConnecting.OnGameSetupFinished -= onSetup;
                AccessTools.Method(typeof(UiRework.CustomMatch.CustomMatchManager), "OnSetupFinished").Invoke(mgr, null);
            };
            CommonNetworking.Instance.MatchConnecting.OnGameSetupFinished += onSetup;
            bool ok2 = CommonNetworking.Instance.MatchConnecting.CreateChallenge(gi, new System.Collections.Generic.List<PlayerDetails>(lobby.AllPlayers));
            log.LogInfo($"Milestone: AutoPlay challenge created ok={ok2}");
        }

        private static void JoinLobby()
        {
            ManualLogSource log = Communitan.logger;
            Lobby lobby = CommonNetworking.Instance.Lobby;
            string me = CommonNetworking.Instance.LocalPlayer.Details.Id;
            if (!string.IsNullOrEmpty(InviteFile))
            {
                File.WriteAllText(InviteFile, me);
            }
            log.LogInfo($"Milestone: AutoPlay waiting for a lobby invite as {me}");
            bool accepting = false;
            // CustomMatchManager subscribes Lobby.GameStarted in Awake; if its object never woke up, start the handshake ourselves.
            var started = AccessTools.Field(typeof(Lobby), "GameStarted");
            Delegate d = started?.GetValue(lobby) as Delegate;
            bool managerListens = d != null && Array.Exists(d.GetInvocationList(), x => x.Target is UiRework.CustomMatch.CustomMatchManager);
            log.LogInfo($"Harness: CustomMatchManager handles lobby start: {managerListens}");
            if (!managerListens)
            {
                lobby.GameStarted += () =>
                {
                    log.LogInfo("Harness: LOBBY_START_GAME -> WaitForStartGame");
                    AccessTools.Method(typeof(UiRework.CustomMatch.CustomMatchManager), "WaitForStartGame").Invoke(Manager, null);
                };
            }
            lobby.LobbyInvite += (gi, inviter) =>
            {
                if (accepting)
                {
                    return;
                }
                accepting = true;
                lobby.Inviter = inviter.GetNameOrDefault();
                log.LogInfo($"Harness: lobby invite from {lobby.Inviter}, accepting");
                // The game's own CustomMatchManager (Lobby.GameStarted -> WaitForHandshake -> load ingame) takes it from here.
                lobby.AcceptInvite(ok =>
                {
                    log.LogInfo($"Milestone: AutoPlay lobby joined ok={ok} lobby={lobby.LobbyId}");
                    Manager?.CreateCustomMatchIfNotAlreadyDone();
                    lobby.ResetIsJoiningLobby();
                    lobby.ResetIsChangingExpansions();
                    if (ok)
                    {
                        lobby.SetPlayerIsReady(true, () => log.LogInfo("Harness: lobby ready sent"));
                    }
                    else
                    {
                        accepting = false;
                    }
                });
            };
        }

        private static ExpansionsEnum AutoPlayExpansion =>
            Enum.TryParse(Communitan.autoPlayExpansion?.Value ?? "", out ExpansionsEnum e) && e != ExpansionsEnum.None ? e : ExpansionsEnum.CatanBaseGame;

        private static bool StartQuickMatch()
        {
            MultiplayerGameInformation gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            var all = (System.Collections.Generic.List<ScenarioSetup>)AccessTools.Field(typeof(ScenarioSetupCollection), "scenarios").GetValue(ScenarioSetupCollection.Instance);
            Communitan.logger.LogInfo("Harness: scenarios " + string.Join(" ", all.ConvertAll(x => $"{x.ScenarioId}/{x.MainExpansion}{(x.IsFreeMatch ? "/free" : "")}{(x.IsTestSetup ? "/test" : "")}").ToArray()));
            ExpansionsEnum exp = AutoPlayExpansion;
            // Exactly what the menu sends (UiRework.ModeSelection/PlayGame.PlayFreeMatch): "" for the base game, which has no
            // free-match scenario. Matched players' scenarios are intersected (NakamaInstance.FinalizeMatchmaking); a bot with a
            // real scenario next to a player with "" leaves nothing in common, the client throws, re-queues and gets kicked later.
            string scenario = ScenarioSetupCollection.Instance.GetScenarioIdForFreematch(exp);
            gi.SetFreeMatch(exp, scenario);
            string mode = Communitan.autoPlayGameMode.Value?.Trim();
            if (!string.IsNullOrEmpty(mode))
            {
                if (!GameModes.ValidId(mode) || !GameModes.PatchesOk)
                {
                    Communitan.logger.LogError($"Harness: game mode '{mode}' not usable (id or patches)");
                    return true; // don't queue a normal game instead
                }
                if (Communitan.autoPlayUi.Value)
                {
                    // the menu path: the mode's Free Play box (GameModesUi), players = the mode's (clamped) count
                    Communitan.instanceRef.StartCoroutine(GameModesUi.HarnessFreePlayBox(mode, ok => Communitan.logger.LogInfo($"Milestone: AutoPlay quick match requested via the mode box (mode={mode}, ok={ok})")));
                    return true;
                }
                GameModes.SetQueued(gi, mode); // matchmaker property + query term, gameInfo.ccsMode (GameModes.cs)
            }
            // Base-game quick match defaults to 3 players; Debug.AutoPlayPlayers=2 lets two harness clients meet (FREEMATCH_2P).
            int players = Communitan.autoPlayPlayers.Value;
            if (players > 0)
            {
                gi.MinPlayers = players;
                gi.MaxPlayers = players;
            }
            bool ok = MonoBehaviourSingleton<WaitForMultiplayerGameController>.Instance.StartMatchmaking();
            Communitan.logger.LogInfo($"Milestone: AutoPlay quick match requested (scenario={scenario}, players={gi.MinPlayers}-{gi.MaxPlayers}, mode={(string.IsNullOrEmpty(mode) ? "-" : mode)}, ok={ok})");
            return ok;
        }

        // Same as the menu's base-game auto (ranked) match (UiRework.ModeSelection/AutoMatchStarter.cs): AUTO_MATCH, all
        // base-game scenarios, 2 players. Free match (QUICK_MATCH) and auto match never match each other.
        private static bool StartAutoMatch()
        {
            MultiplayerGameInformation gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            gi.SetAutoMatch(new System.Collections.Generic.HashSet<ExpansionsEnum> { AutoPlayExpansion });
            gi.SetPlayersCount(PlayersCountEnum.match_2_players);
            int players = Communitan.autoPlayPlayers.Value;
            if (players > 0)
            {
                gi.SetPlayerCountRange(players, players);
            }
            gi.UseTurnTimer = true;
            bool ok = MonoBehaviourSingleton<WaitForMultiplayerGameController>.Instance.StartMatchmaking();
            Communitan.logger.LogInfo($"Milestone: AutoPlay auto match requested (scenarios={string.Join(",", new System.Collections.Generic.List<string>(gi.SelectedScenarios).ToArray())}, players={gi.MinPlayers}-{gi.MaxPlayers}, ok={ok})");
            return ok;
        }
    }

    // Copies every BepInEx log event into an extra per-instance file (env CATAN_LOG); LogOutput.log is shared.
    internal sealed class FileLogListener : ILogListener
    {
        private readonly StreamWriter writer;

        internal FileLogListener(string path)
        {
            writer = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
        }

        public void LogEvent(object sender, LogEventArgs eventArgs)
        {
            if (eventArgs.Source.SourceName == "Unity Log")
            {
                return; // already in Player.log
            }
            lock (writer)
            {
                writer.WriteLine($"[{DateTime.Now:HH:mm:ss.fff} {eventArgs.Level,-7}:{eventArgs.Source.SourceName,10}] {eventArgs.Data}");
            }
        }

        public void Dispose()
        {
            writer.Dispose();
        }
    }
}
