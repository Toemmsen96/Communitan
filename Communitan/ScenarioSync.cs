using Common.Net;
using GameSparks.Core;
using HarmonyLib;
using System.Collections.Generic;

namespace Communitan
{
    // MultiplayerGameInformation.UpdateFromGSData merges the server's "scenarios" into the local set (UnionWith) instead of
    // replacing it. A rejoin then keeps the scenario of the player's last own search: base-game Free Play searches with ""
    // (GetScenarioIdForFreematch), CatanGameComponent.CreateGameStateForMP loads the first entry -> "scenarios/catan/" ->
    // NullReferenceException, empty board. Custom servers: a non-empty server list replaces the local one.
    [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.UpdateFromGSData))]
    internal static class ScenarioSync
    {
        private static void Prefix(MultiplayerGameInformation __instance, GSData infoData)
        {
            if (!ServerList.IsCustomSelected || infoData == null || __instance.SelectedScenarios == null)
            {
                return;
            }
            List<string> server = infoData.GetStringList("scenarios");
            if (server == null || !server.Exists(s => !string.IsNullOrEmpty(s)))
            {
                return;
            }
            if (!__instance.SelectedScenarios.SetEquals(server))
            {
                Communitan.logger.LogInfo($"ScenarioSync: local scenarios [{string.Join(",", new List<string>(__instance.SelectedScenarios).ToArray())}] replaced by the server's [{string.Join(",", server.ToArray())}]");
            }
            __instance.SelectedScenarios.Clear();
        }
    }
}
