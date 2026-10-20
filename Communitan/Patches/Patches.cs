using BepInEx.Logging;
using Common.GameLogic.Communication;
using Common.GameLogic.Model;
using Common.Net;
using Common.Screens;
using Common.Screens.Chat;
using Common.Screens.Overlay;
using Common.Shop;
using Common.Unity;
using GameHub;
using GameHub.Screens;
using GameHub.States;
using GameSparks.Api.Messages;
using GameSparks.Api.Requests;
using GameSparks.Api.Responses;
using GameSparks.Core;
using HarmonyLib;
using System.Collections.Generic;
using Catan.Unity.Components;
using Nakama.Core;
using System;
namespace Communitan.Patches
{
    internal class Patches
    {
        // Set by /setenv at runtime; overrides ServerList.Current until restart.
        internal static NakamaConfig EnvOverride;
        private static string lastLoggedConfig;

        /*
        [HarmonyPatch(typeof(GameSparksConnectionTransport), "SendPlayAction")]
        [HarmonyPostfix]
        private static void LogPlayAction(ref CommonGameState gameState, ref CommonGameActionState action)
        {
            Communitan.logger.LogInfo($"Sending GSCT play action: {action}\nand GameState: {gameState}");
        }

        [HarmonyPatch(typeof(LocalPlayerConnectionTransport), "SendPlayAction")]
        [HarmonyPrefix]
        private static void LogPlayAction2(ref CommonGameState gameState, ref CommonGameActionState action)
        {
            Communitan.logger.LogInfo($"Sending LPCT play action: {action}\nand GameState: {gameState}");
           

        }

        [HarmonyPatch(typeof(AIGameSparksConnectionTransport), "SendPlayAction")]
        [HarmonyPostfix]
        private static void LogPlayAction3(ref CommonGameState gameState, ref CommonGameActionState action)
        {
            Communitan.logger.LogInfo($"Sending AIGSCT play action: {action}\n\nand GameState: {gameState}");
        }
        */

        [HarmonyPatch(typeof(NakamaConnection), MethodType.Constructor, new System.Type[] { typeof(NakamaInstance), typeof(INakamaPlatform), typeof(NakamaConfig) })]
        [HarmonyPrefix]
        private static void RedirectNakamaConfig(ref NakamaConfig config)
        {
            config = EnvOverride ?? ServerList.Current;
            ServerList.RecordAuthEndpoint(ServerList.Endpoint(config));
            string effective = $"{config.Scheme}://{config.Host}:{config.Port} key={config.ServerKey}";
            if (effective != lastLoggedConfig)
            {
                lastLoggedConfig = effective;
                Communitan.logger.LogInfo($"Effective NakamaConfig: {effective} (server={(EnvOverride != null ? "/setenv" : ServerList.Selected)})");
            }
        }

        // Startup milestones for the headless harness (GameSetupReady busy-waits on SteamManager.Initialized).
        [HarmonyPatch(typeof(GameRoot), "GameSetupReady")]
        [HarmonyPrefix]
        private static void LogGameSetupReady()
        {
            Communitan.logger.LogInfo("Milestone: GameSetupReady (waiting for Steam, then main menu)");
        }

        [HarmonyPatch(typeof(GameRoot), "GameSetupReady")]
        [HarmonyPostfix]
        private static void LogGameSetupDone()
        {
            Communitan.logger.LogInfo("Milestone: main menu / login screen shown");
            Communitan.StartAutoConnect();
        }

        [HarmonyPatch(typeof(NetworkResponseBase), "HasError")]
        [HarmonyPostfix]
        private static void LogError(ref bool __result, ref NetworkResponseBase __instance)
        {
            if (__result)
            {
                Communitan.logger.LogError($"NetworkResponseBase error: {__instance.Error.Description}");
            }
        }

        [HarmonyPatch(typeof(NakamaConnector), "LoginToNakamaWithCredentials")]
        [HarmonyPrefix]
        private static void LogLogin(ref string email, ref string password, ref Action<NetworkResponseBase> authenticationCallBack)
        {
            //Communitan.logger.LogInfo($"Logging into Nakama with username: {email} and password: {password} Callback {authenticationCallBack.ToString()}");
        }

        // Returning false skips the original, so a handled /setenv is not sent as chat.
        [HarmonyPatch(typeof(ChatCommandController), "HandleMessage")]
        [HarmonyPrefix]
        private static bool SendCommand(ref string message, ref bool __result)
        {
            string[] args = message.Split(' ');
            if (args[0] != "/setenv")
            {
                return true;
            }
            string env = args.Length > 1 ? args[1] : "";
            if (env == "CUSTOM")
            {
                EnvOverride = null;
            }
            else if (System.Enum.TryParse(env, out OfficialEnv officialEnv))
            {
                EnvOverride = ServerList.GetOfficialConfig(officialEnv);
            }
            else
            {
                Communitan.logger.LogWarning("Invalid environment. Use DEV, PROD, LOCAL, QA or CUSTOM (= back to the selected server list entry).");
                return true;
            }
            Communitan.logger.LogInfo($"Changed environment to {env}");
            __result = true;
            return false;
        }
    }
}
