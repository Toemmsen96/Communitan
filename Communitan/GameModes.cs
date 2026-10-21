using Catan.GameLogic.Model;
using Catan.GameLogic.Rules;
using Common.GameLogic;
using Common.GameLogic.Model;
using Common.Net;
using Common.Net.Nakama;
using Communitan.Rules;
using GameSparks.Core;
using HarmonyLib;
using Nakama.Core;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Communitan
{
    // Server-defined game modes (docs/design/game-modes.md). The rule switches live in rules/ (shared with the referee); this
    // class connects them to the game: only on a custom server, only for the challenge whose GAME_GET_GAME_DETAILS_V3 /
    // GAMESTATE_AND_ACTIONS_V3 carried ccsModeDef (Official servers never send it and never get the capability token).
    //  - capability token "modes-1" (ServerRng.AddCaps): servers refuse mode games to clients without these patches
    //  - mode id of a queued game (Free Play: matchmaker property ccsMode + query term, gameInfo.ccsMode in MatchmakingRequest /
    //    CreateChallenge; the server echoes it back in MatchFoundMessage, kept across MultiplayerGameInformation.UpdateFromGSData)
    internal static class GameModes
    {
        internal const string Caps = "modes-1";
        internal static bool PatchesOk { get; private set; }
        private static readonly Regex IdRx = new Regex("^[a-z0-9_-]{1,32}$");

        private static readonly object gate = new object();
        private static string challengeId; // challenge running a mode (from details/state)
        private static readonly ConditionalWeakTable<MultiplayerGameInformation, StrongBox<string>> queued = new ConditionalWeakTable<MultiplayerGameInformation, StrongBox<string>>();

        private static bool Verbose => Communitan.autoPlay != null && Communitan.autoPlay.Value != AutoPlayMode.Off;

        internal static void Patch(Harmony harmony)
        {
            try
            {
                ModeRules.Patch(harmony);
                harmony.PatchAll(typeof(GameModes));
                ModeRules.Gate = () => Active;
                if (Verbose)
                {
                    ModeRules.Log = msg => Communitan.logger.LogInfo("Modes: " + msg);
                }
                PatchesOk = true;
            }
            catch (Exception e)
            {
                PatchesOk = false;
                Communitan.logger.LogError($"GameModes: patches failed ({e.Message}); servers refuse game modes to this client");
            }
            if (PatchesOk)
            {
                try
                {
                    harmony.PatchAll(typeof(GameModesUi)); // lobby selector, Free Play boxes, versus/invite (custom servers only)
                }
                catch (Exception e)
                {
                    Communitan.logger.LogError($"GameModes: UI patches failed ({e.Message}); mode games can only be joined, not started from the menu");
                }
            }
        }

        // The mode's challenge is the running online game (single player and other challenges: never).
        private static bool Active
        {
            get
            {
                string id = challengeId;
                if (id == null || !ServerList.IsCustomSelected)
                {
                    return false;
                }
                MatchConnectController mc = CommonNetworking.Instance?.MatchConnecting;
                return mc != null && mc.IsMultiplayerRunning && mc.GameInfo != null && mc.GameInfo.ChallengeId == id;
            }
        }

        internal static bool ValidId(string id) => id != null && IdRx.IsMatch(id);

        // Resolved mode of the given game's challenge (details/state of the running or loading online game), else null.
        internal static ModeDef CurrentFor(MultiplayerGameInformation gi)
        {
            lock (gate)
            {
                return gi != null && challengeId != null && gi.ChallengeId == challengeId && ServerList.IsCustomSelected ? ModeRules.Current : null;
            }
        }

        // Display name of the mode a game info carries (running challenge, else its queued/lobby mode id), null = standard game.
        internal static string DisplayName(GameInformation gi)
        {
            MultiplayerGameInformation mgi = gi as MultiplayerGameInformation;
            ModeDef cur = CurrentFor(mgi);
            if (cur != null)
            {
                return string.IsNullOrEmpty(cur.Name) ? cur.Id : cur.Name;
            }
            string id = QueuedMode(mgi);
            return id == null ? null : ModeList.Find(id)?.Name ?? id;
        }

        // ---- mode of the running challenge: details / state responses (start + rejoin), before the game handles them ----
        [HarmonyPatch(typeof(NakamaConnection), "OnMessageReceived")]
        [HarmonyPrefix]
        private static void OnResponse(string message)
        {
            if (message == null || message.IndexOf("\"diceSeed\"", StringComparison.Ordinal) < 0 || message.IndexOf("\"playerDetails\"", StringComparison.Ordinal) < 0)
            {
                return;
            }
            try
            {
                JObject sd = JObject.Parse(message)["scriptData"] as JObject;
                if (sd == null || sd["diceSeed"] == null || sd["playerDetails"] == null)
                {
                    return;
                }
                string id = (string)sd["challengeId"];
                ModeDef def = sd["ccsModeDef"] is JObject o && ServerList.IsCustomSelected ? Parse(o) : null;
                lock (gate)
                {
                    if (def == null)
                    {
                        if (id != null && id == challengeId)
                        {
                            challengeId = null;
                            ModeRules.Current = null;
                        }
                        return;
                    }
                    if (id != challengeId || ModeRules.Current == null || ModeRules.Current.Id != def.Id)
                    {
                        Communitan.logger.LogInfo($"GameModes: challenge {id} plays mode {def}");
                    }
                    challengeId = id;
                    ModeRules.Current = def;
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: bad response: {e.Message}");
            }
        }

        // ccsModeDef = the server's resolved mode JSON (server/data/modes/<id>.json)
        internal static ModeDef Parse(JObject o)
        {
            ModeDef d = new ModeDef { Id = (string)o["id"] ?? "", Name = (string)o["name"] ?? "" };
            JObject rules = o["rules"] as JObject;
            JToken sum = rules?["dice"]?["fixedSum"];
            if (sum != null && sum.Type == JTokenType.Integer)
            {
                d.DiceFixedSum = (int)sum;
            }
            JToken grant = rules?["roundGrant"]?["count"];
            if (grant != null && grant.Type == JTokenType.Integer)
            {
                d.RoundGrant = (int)grant;
            }
            d.Normalize();
            return d;
        }

        // Harness: every applied roll of a mode game (all seats), for tools/mp-smoke.sh / bots checks.
        [HarmonyPatch(typeof(BaseRollDiceRule), nameof(BaseRollDiceRule.Apply))]
        [HarmonyPostfix]
        private static void LogRoll(CommonGameState gameState)
        {
            if (Verbose && ModeRules.Active != null && gameState?.CatanGameState?.Match?.DiceValues != null)
            {
                Communitan.logger.LogInfo($"Modes: roll turn={gameState.CatanGameState.Match.TurnNumber} dice=[{string.Join(",", gameState.CatanGameState.Match.DiceValues)}]");
            }
        }

        // ---- mode id of a queued / lobby game (MultiplayerGameInformation keeps no unknown keys) ----
        internal static void SetQueued(MultiplayerGameInformation gi, string mode)
        {
            if (gi == null)
            {
                return;
            }
            queued.Remove(gi);
            if (ValidId(mode))
            {
                queued.Add(gi, new StrongBox<string>(mode));
            }
        }

        internal static string QueuedMode(MultiplayerGameInformation gi)
        {
            return gi != null && ServerList.IsCustomSelected && queued.TryGetValue(gi, out StrongBox<string> b) ? b.Value : null;
        }

        [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.Reset))]
        [HarmonyPrefix]
        private static void OnReset(MultiplayerGameInformation __instance)
        {
            queued.Remove(__instance);
        }

        // The match state machine queues copies (MatchStartState: new MultiplayerGameInformation(gi), .Copy() for the ticket).
        [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.Copy))]
        [HarmonyPostfix]
        private static void OnCopy(MultiplayerGameInformation __instance, MultiplayerGameInformation __result)
        {
            if (queued.TryGetValue(__instance, out StrongBox<string> b))
            {
                SetQueued(__result, b.Value);
            }
        }

        [HarmonyPatch(typeof(MultiplayerGameInformation), MethodType.Constructor, new[] { typeof(MultiplayerGameInformation) })]
        [HarmonyPostfix]
        private static void OnCopyCtor(MultiplayerGameInformation __instance, MultiplayerGameInformation other)
        {
            if (other != null && queued.TryGetValue(other, out StrongBox<string> b))
            {
                SetQueued(__instance, b.Value);
            }
        }

        [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.ToGSData))]
        [HarmonyPostfix]
        private static void ToGSData(MultiplayerGameInformation __instance, GSData __result)
        {
            string mode = QueuedMode(__instance);
            if (mode != null && __result != null)
            {
                __result.BaseData["ccsMode"] = mode;
            }
        }

        // MatchFoundMessage / lobby / details game info: the server's mode (it validated it) replaces ours.
        [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.UpdateFromGSData))]
        [HarmonyPostfix]
        private static void FromGSData(MultiplayerGameInformation __instance, GSData infoData)
        {
            if (infoData == null || !ServerList.IsCustomSelected)
            {
                return;
            }
            string mode = infoData.GetString("ccsMode");
            if (mode == null && infoData.ContainsKey("scriptData"))
            {
                mode = infoData.GetGSData("scriptData")?.GetString("ccsMode");
            }
            SetQueued(__instance, mode);
        }

        // Free Play box of a mode (GameModesUi): PlayGame.PlayFreeMatch -> SetFreeMatch (Reset) -> StartMatchmaking, all synchronous.
        internal static ModeInfo PendingFreePlay;

        [HarmonyPatch(typeof(MultiplayerGameInformation), nameof(MultiplayerGameInformation.SetFreeMatch))]
        [HarmonyPostfix]
        private static void OnSetFreeMatch(MultiplayerGameInformation __instance)
        {
            ModeInfo m = PendingFreePlay;
            if (m == null || !ServerList.IsCustomSelected)
            {
                return;
            }
            SetQueued(__instance, m.Id);
            // the server clamps the ticket to the mode's player count too (modes.ts modeMatchmaker); keep the client consistent
            int n = Math.Max(m.Min, Math.Min(m.Max, __instance.MinPlayers));
            __instance.MinPlayers = n;
            __instance.MaxPlayers = n;
            Communitan.logger.LogInfo($"GameModes: Free Play for mode {m.Id} ({n} players)");
        }

        // Free Play queue of a mode: own matchmaker pool per mode (the server also enforces it in its MatchmakerAdd hook).
        [HarmonyPatch(typeof(NakamaQueryConfig), MethodType.Constructor, new[] { typeof(MultiplayerGameInformation), typeof(string), typeof(HashSet<string>), typeof(HashSet<string>) })]
        [HarmonyPostfix]
        private static void QueryProperties(NakamaQueryConfig __instance, MultiplayerGameInformation gameInfo)
        {
            string mode = QueuedMode(gameInfo);
            if (mode != null && __instance.StringProperties != null)
            {
                __instance.StringProperties["ccsMode"] = mode;
                Communitan.logger.LogInfo($"GameModes: matchmaking for mode {mode}");
            }
        }

        [HarmonyPatch(typeof(NakamaQueryConfig), nameof(NakamaQueryConfig.ToString))]
        [HarmonyPostfix]
        private static void QueryString(NakamaQueryConfig __instance, ref string __result)
        {
            string mode = QueuedMode(__instance.GameInfo);
            if (mode != null && __result != null && __result.IndexOf("properties.ccsMode:", StringComparison.Ordinal) < 0)
            {
                __result += " +properties.ccsMode:" + mode;
            }
        }
    }
}
