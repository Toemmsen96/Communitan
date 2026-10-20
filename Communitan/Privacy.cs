using GameSparks.Core;
using GameSparks.Platforms;
using HarmonyLib;
using Nakama.Core;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Communitan
{
    // Hardening while a custom server is selected (ServerList.IsCustomSelected); the official servers are never affected.
    // - Steam ID: STEAM_ID / steamId keys are removed from every outgoing GS request.
    // - Device id: guest logins use sha256(real id + "|" + host:port) (40 hex chars), so servers can't correlate players.
    //   Harness Debug.DeviceIdOverride wins; entries with LegacyDeviceId keep the real id (pre-existing guests).
    // - Privacy.BlockAnalytics: GameAnalytics calls are dropped and its endpoints point nowhere; Unity Analytics,
    //   performance reporting and Unity Gaming Services init are switched off.
    internal static class Privacy
    {
        private static readonly string[] SteamKeys = { "STEAM_ID", "steamId" };
        private const string DeadEndpoint = "http://127.0.0.1:9";
        private static readonly Dictionary<string, string> saltCache = new Dictionary<string, string>();
        // salted -> real: PlatformBase caches whatever SystemInfo returned at its Start (maybe salted for another server).
        private static readonly Dictionary<string, string> realOf = new Dictionary<string, string>();
        private static bool? analyticsWasEnabled, deviceStatsWasEnabled, perfReportingWasEnabled;

        internal static bool BlockAnalytics => Communitan.blockAnalytics.Value && ServerList.IsCustomSelected;

        internal static void Patch(Harmony harmony)
        {
            harmony.PatchAll(typeof(Privacy));
            // GameAnalytics (GameAnalyticsSDK.dll / GameAnalytics.dll): optional, patched by name.
            HarmonyMethod skip = new HarmonyMethod(typeof(Privacy), nameof(SkipWhenBlocked));
            Type ga = AccessTools.TypeByName("GameAnalyticsSDK.GameAnalytics");
            foreach (MethodInfo method in ga?.GetMethods(BindingFlags.Public | BindingFlags.Static) ?? new MethodInfo[0])
            {
                if (method.ReturnType == typeof(void) && (method.Name.StartsWith("New") || method.Name == "Initialize" || method.Name == "StartSession" || method.Name == "SetCustomId"))
                {
                    harmony.Patch(method, prefix: skip);
                }
            }
            Type http = AccessTools.TypeByName("GameAnalyticsSDK.Net.Http.GAHTTPApi");
            HarmonyMethod dead = new HarmonyMethod(typeof(Privacy), nameof(DeadUrlWhenBlocked));
            foreach (string name in new[] { "getBaseUrl", "getRemoteConfigsBaseUrl" })
            {
                MethodInfo method = http != null ? AccessTools.Method(http, name) : null;
                if (method != null)
                {
                    harmony.Patch(method, postfix: dead);
                }
            }
            Type payment = AccessTools.TypeByName("Common.Payment.PaymentController");
            MethodInfo ugs = payment != null ? AccessTools.Method(payment, "InitializeUnityServices") : null;
            if (ugs != null)
            {
                harmony.Patch(ugs, prefix: new HarmonyMethod(typeof(Privacy), nameof(SkipUnityServices)));
            }
            if (ga == null || http == null || ugs == null)
            {
                Communitan.logger.LogWarning($"Privacy: analytics hooks missing (GameAnalytics={ga != null}, GAHTTPApi={http != null}, UGS={ugs != null})");
            }
            Apply();
        }

        // Called at startup and after every server switch.
        internal static void Apply()
        {
            bool block = BlockAnalytics;
            try
            {
                if (block)
                {
                    analyticsWasEnabled ??= UnityEngine.Analytics.Analytics.enabled;
                    deviceStatsWasEnabled ??= UnityEngine.Analytics.Analytics.deviceStatsEnabled;
                    perfReportingWasEnabled ??= UnityEngine.Analytics.PerformanceReporting.enabled;
                    UnityEngine.Analytics.Analytics.enabled = false;
                    UnityEngine.Analytics.Analytics.deviceStatsEnabled = false;
                    UnityEngine.Analytics.PerformanceReporting.enabled = false;
                }
                else if (analyticsWasEnabled.HasValue)
                {
                    UnityEngine.Analytics.Analytics.enabled = analyticsWasEnabled.Value;
                    UnityEngine.Analytics.Analytics.deviceStatsEnabled = deviceStatsWasEnabled.Value;
                    UnityEngine.Analytics.PerformanceReporting.enabled = perfReportingWasEnabled.Value;
                    analyticsWasEnabled = deviceStatsWasEnabled = perfReportingWasEnabled = null;
                }
                Type ga = AccessTools.TypeByName("GameAnalyticsSDK.GameAnalytics");
                if (ga != null && (bool)AccessTools.Property(ga, "Initialized").GetValue(null))
                {
                    AccessTools.Method(ga, "SetEnabledEventSubmission", new[] { typeof(bool), typeof(bool) })?.Invoke(null, new object[] { !block, !block });
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Privacy: analytics switch failed: {e.Message}");
            }
            Communitan.logger.LogInfo($"Privacy: custom={ServerList.IsCustomSelected} blockAnalytics={block}");
        }

        private static bool SkipWhenBlocked()
        {
            return !BlockAnalytics;
        }

        private static void DeadUrlWhenBlocked(ref string __result)
        {
            if (BlockAnalytics)
            {
                __result = DeadEndpoint;
            }
        }

        private static bool SkipUnityServices(ref System.Threading.Tasks.Task __result)
        {
            if (!BlockAnalytics)
            {
                return true;
            }
            __result = System.Threading.Tasks.Task.CompletedTask;
            return false;
        }

        // ---- Steam ID ----
        [HarmonyPatch(typeof(NakamaConnection), "AddPendingRequest")]
        [HarmonyPrefix]
        private static void StripSteamId(GSRequest request)
        {
            if (ServerList.IsCustomSelected)
            {
                Strip(request.BaseData);
            }
        }

        private static void Strip(IDictionary<string, object> data)
        {
            foreach (string key in data.Keys.Where(k => SteamKeys.Any(s => string.Equals(s, k, StringComparison.OrdinalIgnoreCase))).ToList())
            {
                data.Remove(key);
            }
            foreach (object value in data.Values)
            {
                if (value is GSData nested)
                {
                    Strip(nested.BaseData);
                }
                else if (value is IDictionary<string, object> dict)
                {
                    Strip(dict);
                }
            }
        }

        // ---- device id ----
        [HarmonyPatch(typeof(SystemInfo), "get_deviceUniqueIdentifier")]
        [HarmonyPostfix]
        private static void SaltSystemDeviceId(ref string __result)
        {
            __result = Salt(__result);
        }

        [HarmonyPatch(typeof(PlatformBase), "get_DeviceId")]
        [HarmonyPostfix]
        private static void SaltPlatformDeviceId(ref string __result)
        {
            __result = Salt(__result);
        }

        internal static string Salt(string id)
        {
            if (Harness.DeviceIdOverride != null || string.IsNullOrEmpty(id))
            {
                return id;
            }
            lock (saltCache)
            {
                string real = realOf.TryGetValue(id, out string original) ? original : id;
                ServerEntry entry = ServerList.CurrentEntry;
                if (!ServerList.IsCustomSelected || entry == null || entry.LegacyDeviceId)
                {
                    return real;
                }
                string key = real + "|" + entry.HostPort;
                if (!saltCache.TryGetValue(key, out string salted))
                {
                    using (SHA256 sha = SHA256.Create())
                    {
                        salted = string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(key)).Select(b => b.ToString("x2"))).Substring(0, 40);
                    }
                    saltCache[key] = salted;
                    realOf[salted] = real;
                }
                return salted;
            }
        }
    }
}
