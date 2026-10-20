using Common.Net;
using Common.Shop;
using Common.Unity.Utilities;
using GameSparks.Api.Requests;
using HarmonyLib;
using Nakama.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

namespace Communitan
{
    // Mirrors the player's own official purchases to custom servers running CATAN_ENTITLEMENTS=owned (docs/HOSTING.md).
    //  - Official (PROD) login: each AccountDetailsResponse records expansions bitmask + owned virtualGoods ids
    //    + sha256(official user id) + time into Communitan.entitlements.json (next to the server list).
    //    No tokens, no email, no currency, no progress.
    //  - Custom server login (ACCOUNT_LOGIN response): if the server's public status says entitlements=owned, sends that
    //    record as COMMUNITAN_ENTITLEMENTS_CLAIM, then re-requests AccountDetails so the menus refresh. Servers in any other mode
    //    never receive it. No record yet: one-time hint to log in to the official servers once.
    internal class Entitlements : MonoBehaviour
    {
        private const string FileName = "Communitan.entitlements.json";
        private static readonly object gate = new object();
        private static volatile string pendingLogin; // "<endpoint>|<userId>" set off the main thread, handled in Update
        private static readonly HashSet<string> claimed = new HashSet<string>(); // per endpoint|userId, this game session

        internal static string FilePath => Path.Combine(Path.GetDirectoryName(ServerList.FilePath), FileName);

        private static bool OfficialProd => Patches.Patches.EnvOverride == null && ServerList.CurrentEntry == null && Communitan.officialEnv.Value == OfficialEnv.PROD;

        // ---- responses (network thread) ----
        [HarmonyPatch(typeof(NakamaConnection), "OnMessageReceived")]
        [HarmonyPrefix]
        private static void OnResponse(string message)
        {
            if (message == null)
            {
                return;
            }
            bool details = message.IndexOf(".AccountDetailsResponse", StringComparison.Ordinal) >= 0;
            bool login = !details && message.IndexOf("\"ACCOUNT_LOGIN\"", StringComparison.Ordinal) >= 0;
            if (!details && !login)
            {
                return;
            }
            try
            {
                JObject o = JObject.Parse(message);
                if (o["error"] != null)
                {
                    return;
                }
                JObject sd = o["scriptData"] as JObject;
                if (details && OfficialProd)
                {
                    Record(o, sd);
                }
                else if (login && ServerList.IsCustomSelected && (string)o["eventKey"] == "ACCOUNT_LOGIN" && sd?["userId"] != null)
                {
                    pendingLogin = ServerList.Endpoint(ServerList.Current) + "|" + (string)sd["userId"];
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Entitlements: bad response: {e.Message}");
            }
        }

        private static void Record(JObject o, JObject sd)
        {
            string userId = (string)sd?["userId"] ?? (string)o["userId"];
            JObject goods = sd?["virtualGoods"] as JObject ?? o["virtualGoods"] as JObject;
            if (string.IsNullOrEmpty(userId) || sd?["expansions"] == null || goods == null)
            {
                return;
            }
            JObject rec = Load() ?? new JObject();
            rec["expansions"] = (long)sd["expansions"];
            rec["items"] = new JArray(goods.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
            rec["officialUserHash"] = Sha256Hex(userId);
            rec["capturedAt"] = DateTime.UtcNow.ToString("o");
            Save(rec);
            Communitan.logger.LogInfo($"Entitlements: recorded official purchases (expansions={rec["expansions"]}, {((JArray)rec["items"]).Count} items) to {FilePath}");
        }

        private static string Sha256Hex(string s)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(s)).Select(b => b.ToString("x2")).ToArray());
            }
        }

        private static JObject Load()
        {
            lock (gate)
            {
                try
                {
                    if (!File.Exists(FilePath))
                    {
                        return null;
                    }
                    // keep capturedAt a string (default parsing turns ISO dates into a culture-formatted DateTime)
                    using (JsonTextReader reader = new JsonTextReader(new StringReader(File.ReadAllText(FilePath))) { DateParseHandling = DateParseHandling.None })
                    {
                        return JObject.Load(reader);
                    }
                }
                catch (Exception e)
                {
                    Communitan.logger.LogWarning($"Entitlements: cannot read {FilePath}: {e.Message}");
                    return null;
                }
            }
        }

        private static void Save(JObject rec)
        {
            lock (gate)
            {
                try
                {
                    string tmp = FilePath + ".tmp";
                    File.WriteAllText(tmp, rec.ToString());
                    if (File.Exists(FilePath))
                    {
                        File.Delete(FilePath);
                    }
                    File.Move(tmp, FilePath);
                }
                catch (Exception e)
                {
                    Communitan.logger.LogWarning($"Entitlements: cannot write {FilePath}: {e.Message}");
                }
            }
        }

        // ---- custom server login (main thread) ----
        private void Update()
        {
            string login = pendingLogin;
            if (login == null)
            {
                return;
            }
            pendingLogin = null;
            if (!claimed.Add(login))
            {
                return;
            }
            ServerEntry entry = ServerList.CurrentEntry;
            if (entry != null)
            {
                StartCoroutine(Claim(entry, login));
            }
        }

        private IEnumerator Claim(ServerEntry entry, string login)
        {
            Task<ServerStatus> task = ServerPing.FetchStatus(entry.Url, entry.EffectiveStatusKey);
            while (!task.IsCompleted)
            {
                yield return null;
            }
            ServerStatus status = task.Status == TaskStatus.RanToCompletion ? task.Result : null;
            if (status?.Entitlements != "owned")
            {
                Communitan.logger.LogInfo($"Entitlements: {entry.Name} is in mode '{status?.Entitlements ?? "unknown"}', nothing sent");
                yield break;
            }
            JObject rec = Load();
            if (rec?["officialUserHash"] == null)
            {
                if (rec?["hintShown"] == null || !(bool)rec["hintShown"])
                {
                    yield return new WaitForSeconds(2f);
                    if (ShowDialog("Mirror your purchases", "This server unlocks what you bought on the official Catan Universe servers, but this PC has no record of it yet.\n\nLog in to the official servers once (with this mod installed), then come back here. Only the ids of your expansions and items and a hash of your official user id are sent, nothing else."))
                    {
                        rec = rec ?? new JObject();
                        rec["hintShown"] = true;
                        Save(rec);
                    }
                }
                Communitan.logger.LogInfo("Entitlements: no official record yet, nothing sent");
                yield break;
            }
            if (!ServerList.IsCustomSelected || ServerList.Endpoint(ServerList.Current) != login.Substring(0, login.LastIndexOf('|')))
            {
                yield break; // server switched meanwhile
            }
            List<string> items = (rec["items"] as JArray)?.Select(t => (string)t).Where(s => !string.IsNullOrEmpty(s)).ToList() ?? new List<string>();
            new LogEventRequest()
                .SetEventKey("COMMUNITAN_ENTITLEMENTS_CLAIM")
                .SetEventAttribute("expansions", (long?)rec["expansions"] ?? 0L)
                .SetEventAttribute("items", items)
                .SetEventAttribute("officialUserHash", (string)rec["officialUserHash"])
                .SetEventAttribute("capturedAt", (string)rec["capturedAt"] ?? "")
                .Send(response =>
                {
                    if (response.HasErrors)
                    {
                        string code = response.Errors?.GetString("code");
                        Communitan.logger.LogWarning($"Entitlements: claim refused by {entry.Name}: {code ?? response.JSONString}");
                        if (code == "ENTITLEMENTS_ALREADY_CLAIMED")
                        {
                            ShowDialog("Purchases already linked", "Your official purchases are already linked to another account on this server. Each official account can unlock one account per server; ask the server operator if this is wrong.");
                        }
                        return;
                    }
                    Communitan.logger.LogInfo($"Entitlements: mirrored to {entry.Name}: expansions={response.ScriptData?.GetLong("expansions")}, items={response.ScriptData?.GetInt("items")}, rejected={response.ScriptData?.GetInt("rejected")}");
                    Refresh();
                });
        }

        // Menus read entitlements from the account details; the shop caches product flags for 10 min.
        private static void Refresh()
        {
            try
            {
                CommonNetworking.Instance?.LocalPlayer?.UpdateDetailsFromServer();
                ShopContentController shop = MonoBehaviourSingleton<ShopContentController>.Instance;
                shop?.GetProductsList(new List<ProductCategoryEnum> { ProductCategoryEnum.Expansion, ProductCategoryEnum.Bundle, ProductCategoryEnum.AvatarCollection }, null, forceReload: true);
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Entitlements: refresh failed: {e.Message}");
            }
        }

        private static bool ShowDialog(string header, string text)
        {
            try
            {
                UiRework.PopupManager pm = UiRework.PopupManager.Instance;
                if (pm?.DialogBox == null)
                {
                    return false;
                }
                pm.DialogBox.ShowWith1Button(header, text);
                return true;
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Entitlements: cannot show dialog: {e.Message}");
                return false;
            }
        }
    }
}
