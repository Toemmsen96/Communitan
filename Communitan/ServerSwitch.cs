using Common.Net;
using HarmonyLib;
using Nakama.Core;
using System;

namespace Communitan
{
    // Applies a server choice: logs out of the old server, drops a stored login that belongs to another
    // server and holds back the game's startup login (SetupStartMenuState) until the picker has a choice.
    internal static class ServerSwitch
    {
        // True while the startup picker is waiting for a choice; the game must not connect meanwhile.
        internal static bool StartupPending;
        private static NakamaConnector deferredMenu;
        private static NakamaConnector deferredStart;
        private static Action<bool> deferredStartDone;

        // The game reached its start menu and is waiting for the startup picker.
        internal static bool MenuDeferred => deferredMenu != null;

        internal static NakamaConfig Effective => Patches.Patches.EnvOverride ?? ServerList.Current;

        // NakamaConnector.StartGameSparks ran at least once (it adds the NakamaUnity component).
        private static bool ConnectionStarted => CommonNetworking.Instance != null && CommonNetworking.Instance.NakamaConnector != null
            && AccessTools.Field(typeof(NakamaConnector), "nakamaUnity").GetValue(CommonNetworking.Instance.NakamaConnector) as UnityEngine.Object != null;

        // select: changes ServerList's selection. Ends the session if the endpoint changed.
        internal static void Apply(Action select)
        {
            string before = ServerList.Endpoint(Effective);
            select();
            Patches.Patches.EnvOverride = null;
            string after = ServerList.Endpoint(Effective);
            Communitan.logger.LogInfo($"Server selected: {ServerList.Selected} ({after})");
            if (before != after && ConnectionStarted)
            {
                Communitan.logger.LogInfo($"Server changed from {before}: terminating the current session");
                try
                {
                    CommonNetworking.Instance.Authentication.TerminateSession();
                }
                catch (Exception e)
                {
                    Communitan.logger.LogError($"TerminateSession failed: {e}");
                }
            }
            ClearStaleAuth();
            Privacy.Apply();
            LoginHints.Refresh();
        }

        // Deletes user.config (the game's saved login/token) if it was made against another endpoint.
        internal static void ClearStaleAuth()
        {
            string now = ServerList.Endpoint(Effective);
            string authed = ServerList.AuthEndpoint;
            if (now != authed && AuthenticationDetailsSerializer.LocalAuthenticationExists())
            {
                Communitan.logger.LogInfo($"Stored login belongs to {authed}, not {now}: deleting it");
                AuthenticationDetailsSerializer.DeleteCurrentAuthentication();
            }
        }

        // Startup picker made its choice: let the game continue to the login screen / auto re-login.
        internal static void ReleaseStartup()
        {
            if (!StartupPending)
            {
                return;
            }
            StartupPending = false;
            if (deferredMenu != null)
            {
                NakamaConnector menu = deferredMenu;
                deferredMenu = null;
                menu.SetupStartMenuState();
            }
            if (deferredStart != null)
            {
                NakamaConnector start = deferredStart;
                deferredStart = null;
                start.StartGameSparks(deferredStartDone);
                deferredStartDone = null;
            }
        }

        [HarmonyPatch(typeof(NakamaConnector), "SetupStartMenuState")]
        [HarmonyPrefix]
        private static bool DeferStartMenu(NakamaConnector __instance)
        {
            if (!StartupPending)
            {
                return true;
            }
            Communitan.logger.LogInfo("Login screen / auto re-login deferred until a server is picked");
            deferredMenu = __instance;
            return false;
        }

        [HarmonyPatch(typeof(NakamaConnector), "StartGameSparks")]
        [HarmonyPrefix]
        private static bool DeferConnect(NakamaConnector __instance, Action<bool> onDone)
        {
            if (!StartupPending)
            {
                return true;
            }
            Communitan.logger.LogWarning("Nakama connect deferred until a server is picked");
            deferredStart = __instance;
            deferredStartDone = onDone;
            return false;
        }
    }
}
