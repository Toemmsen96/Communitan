using GameSparks.Core;
using HarmonyLib;
using Nakama;
using Nakama.Core;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace Communitan.Patches
{
    // GS-emulation traffic as seen by NakamaConnection: send = GS request, recv = GS response, push = notification.
    internal class TrafficPatches
    {
        // requestId -> rpc id, so responses can be tagged with the id of the request they answer.
        private static readonly ConcurrentDictionary<string, string> pendingIds = new ConcurrentDictionary<string, string>();

        private static string ShortClass(string cls)
        {
            if (string.IsNullOrEmpty(cls))
            {
                return null;
            }
            int dot = cls.LastIndexOf('.');
            return dot >= 0 ? cls.Substring(dot + 1) : cls;
        }

        // AddPendingRequest is the first call in SendImmediate (its only caller) and assigns requestId,
        // so a postfix here sees the final request.JSON and runs before any (sync) error response.
        [HarmonyPatch(typeof(NakamaConnection), "AddPendingRequest")]
        [HarmonyPostfix]
        private static void LogSend(GSRequest request)
        {
            try
            {
                string type = ShortClass(request.GetString("@class"));
                string requestId = request.GetString("requestId");
                string id = request.GetString("eventKey") ?? type;
                if (requestId != null)
                {
                    pendingIds[requestId] = id;
                }
                JToken data = TrafficLogger.ToToken(request.JSON);
                if (data is JObject obj && obj["password"] != null)
                {
                    obj["password"] = "***";
                }
                TrafficLogger.Log("send", id, data, new JObject { ["rid"] = requestId, ["type"] = type });
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"LogSend failed: {e.Message}");
            }
        }

        [HarmonyPatch(typeof(NakamaConnection), "OnMessageReceived")]
        [HarmonyPrefix]
        private static void LogRecv(string message)
        {
            try
            {
                JToken data = TrafficLogger.ToToken(message);
                string cls = null;
                string requestId = null;
                if (data is JObject obj)
                {
                    cls = (string)obj["@class"];
                    requestId = (string)obj["requestId"];
                }
                string id = null;
                if (requestId != null)
                {
                    pendingIds.TryRemove(requestId, out id);
                }
                TrafficLogger.Log("recv", id ?? ShortClass(cls), data, new JObject { ["rid"] = requestId, ["type"] = ShortClass(cls) });
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"LogRecv failed: {e.Message}");
            }
        }

        [HarmonyPatch(typeof(NakamaConnection), "OnNakamaNotification")]
        [HarmonyPrefix]
        private static void LogPush(IApiNotification notification)
        {
            try
            {
                JToken data = TrafficLogger.ToToken(notification.Content);
                string id = notification.Subject;
                if (data is JObject obj)
                {
                    string cls = ShortClass((string)obj["@class"]);
                    string extCode = (string)obj["extCode"];
                    id = extCode != null ? $"{cls}:{extCode}" : (cls ?? id);
                }
                TrafficLogger.Log("push", id, data, new JObject { ["subject"] = notification.Subject, ["code"] = notification.Code, ["nid"] = notification.Id });
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"LogPush failed: {e.Message}");
            }
        }
    }

    // Nakama SDK auth results (email/device/custom/...): id = SDK method name.
    [HarmonyPatch]
    internal class AuthPatches
    {
        private static IEnumerable<MethodBase> TargetMethods()
        {
            return typeof(Client).GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.Name.StartsWith("Authenticate") && m.ReturnType == typeof(Task<ISession>))
                .Cast<MethodBase>();
        }

        private static void Postfix(MethodBase __originalMethod, Task<ISession> __result)
        {
            string id = __originalMethod.Name;
            __result?.ContinueWith(task =>
            {
                JObject data;
                if (task.IsFaulted || task.IsCanceled)
                {
                    Exception e = task.Exception?.GetBaseException();
                    data = new JObject { ["ok"] = false, ["error"] = e?.Message ?? "canceled", ["errorType"] = e?.GetType().Name };
                }
                else
                {
                    ISession session = task.Result;
                    data = new JObject
                    {
                        ["ok"] = true,
                        ["userId"] = session.UserId,
                        ["username"] = session.Username,
                        ["created"] = session.Created,
                        ["vars"] = session.Vars != null ? JObject.FromObject(session.Vars) : null
                    };
                }
                TrafficLogger.Log("auth", id, data);
            });
        }
    }
}
