using Common;
using Common.Net;
using Common.Unity.UI;
using HarmonyLib;
using Nakama;
using Nakama.Core;
using System;
using UnityEngine;
using UnityGameBase.Core.Globalization;

namespace Communitan
{
    // Says why the server's referee removed the player (server/src/referee.ts, kick reason INVALID_GAME_DATA). The game
    // has no such reason: a live kick shows "disconnected from the internet for too long" (KickedBecauseDisconnectHandler,
    // and only if no kick message was shown before), menu rejoin of an unknown reason says "kicked from the last game"
    // (MatchReconnectHandler.ShowYouWereKickedMessage).
    //  - live: GAME_PLAYER_WAS_KICKED with the custom field ccsKickReason -> the game's popup is suppressed and the mod
    //    shows its own dialog once the main menu is up.
    //  - login: wasKickedReason in the session info -> that message's texts are replaced.
    internal class KickReasonText : MonoBehaviour
    {
        private const string Reason = "INVALID_GAME_DATA";
        private const string Header = "Removed from the game";
        private const string Body = "This server checks every move against the game rules. Your game sent a move the rules don't allow (for example a forced card or a modified roll), so you were removed from the match. An AI plays your seat.\n\nModified game clients can't play on this server.";
        private static volatile bool pendingDialog, pendingLogin;
        private float menuSince = -1f;

        // Pushes arrive as notifications, the login session info as an RPC response.
        [HarmonyPatch(typeof(NakamaConnection), "OnNakamaNotification")]
        [HarmonyPrefix]
        private static void OnNotification(IApiNotification notification)
        {
            Check(notification?.Content);
        }

        [HarmonyPatch(typeof(NakamaConnection), "OnMessageReceived")]
        [HarmonyPrefix]
        private static void OnMessage(string message)
        {
            Check(message);
        }

        private static void Check(string message)
        {
            if (message == null || message.IndexOf(Reason, StringComparison.Ordinal) < 0 || !ServerList.IsCustomSelected)
            {
                return;
            }
            string me = CommonNetworking.Instance?.LocalPlayer?.LoggedInUserId;
            if (message.IndexOf("GAME_PLAYER_WAS_KICKED", StringComparison.Ordinal) >= 0 && message.IndexOf("\"ccsKickReason\":\"" + Reason + "\"", StringComparison.Ordinal) >= 0
                && !string.IsNullOrEmpty(me) && message.IndexOf("\"playerId\":\"" + me + "\"", StringComparison.Ordinal) >= 0)
            {
                pendingDialog = true;
                pendingLogin = false; // the same kick would come back as wasKickedReason at the next login
                Communitan.logger.LogInfo("KickReasonText: removed by the server's referee (" + Reason + ")");
            }
            else if (!pendingDialog && message.IndexOf("\"wasKickedReason\":\"" + Reason + "\"", StringComparison.Ordinal) >= 0)
            {
                pendingLogin = true;
            }
        }

        private void Update()
        {
            if (!pendingDialog)
            {
                menuSince = -1f;
                return;
            }
            // the game's own (misleading) popup checks this flag; it is reset when a game scene is entered
            ShowYouGotKickedMessageController kicked = ShowYouGotKickedMessageController.Instance;
            if (kicked != null && !kicked.AlreadyShown)
            {
                kicked.SetHasAlreadyShownMessage();
            }
            if (!SceneHelper.IsInMainMenu || CatanLoadingScreen.IsShowingLoader)
            {
                menuSince = -1f;
                return;
            }
            if (menuSince < 0f)
            {
                menuSince = Time.unscaledTime;
            }
            UiRework.PopupManager pm = UiRework.PopupManager.Instance;
            if (Time.unscaledTime - menuSince < 1f || pm?.DialogBox == null)
            {
                return;
            }
            pendingDialog = false;
            try
            {
                pm.DialogBox.ShowWith1Button(Header, Body);
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"KickReasonText: cannot show dialog: {e.Message}");
            }
        }

        [HarmonyPatch(typeof(GameLocalization), nameof(GameLocalization.GetText), new Type[] { typeof(string) })] // LString's overload
        [HarmonyPostfix]
        private static void Text(string pKey, ref string __result)
        {
            if (!pendingLogin)
            {
                return;
            }
            switch (pKey)
            {
                case "network_session_was_closed_header":
                    __result = Header;
                    break;
                case "was_kicked_from_last_game":
                    __result = Body;
                    pendingLogin = false; // one message
                    break;
            }
        }
    }
}
