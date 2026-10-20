using GameHub.States;
using GameHub.Screens;
using GameSparks.Api.Requests;
using HarmonyLib;
using TMPro;
using UiRework;
using UnityEngine;

namespace Communitan
{
    // Email registration without email on custom servers (server: ACCOUNT_RESEND_ACTIVATION_CODE returns the code to
    // the logged-in caller only, docs/protocol/account-social.md). On the activation screen (RegisterStep2) the code is
    // fetched with the game's own request class, pre-filled and shown; the user still presses Activate.
    // delivery "auto" (verified account / server mode off): submitted automatically.
    // Not Authentication.ResendRegisterCode: its success path (OnCodeActivated) marks the client as verified.
    internal static class RegisterFlow
    {
        private const string LineName = "Communitan_ActivationCode";
        private static RegisterStep2ScreenRework step2;

        [HarmonyPatch(typeof(RegisterStep2ScreenRework), "Show")]
        [HarmonyPostfix]
        private static void OnStep2Show(RegisterStep2ScreenRework __instance)
        {
            step2 = __instance;
            if (!ServerList.IsCustomSelected)
            {
                SetLine(__instance, null);
                return;
            }
            FetchCode(__instance);
        }

        // The game's "resend" would show "mail sent"; on custom servers fetch and show the code again instead.
        [HarmonyPatch(typeof(RegisterStep2State), "HandleOnResendActivation")]
        [HarmonyPrefix]
        private static bool OnResend()
        {
            if (!ServerList.IsCustomSelected || step2 == null)
            {
                return true;
            }
            FetchCode(step2);
            return false;
        }

        // "registration_mail_sent" push after registering: no email was sent on custom servers.
        [HarmonyPatch(typeof(PopupMessage), nameof(PopupMessage.ShowMessage))]
        [HarmonyPrefix]
        private static void ReplaceMailSent(ref string header, ref string content)
        {
            if (ServerList.IsCustomSelected && header == UnityGameBase.Game.Instance?.gameLoca?.GetText("registration_mail_sent"))
            {
                header = "Account created";
                content = "This community server sends no emails. Your activation code is shown on the activation screen.";
            }
        }

        private static void FetchCode(RegisterStep2ScreenRework screen)
        {
            SetLine(screen, "Getting your activation code ...");
            string email = (RegisterStep2State.CurrentEmail ?? "").ToLower();
            new LogEventRequest_ACCOUNT_RESEND_ACTIVATION_CODE().Set_email(email).Send(response =>
            {
                if (screen == null || !screen.isActiveAndEnabled)
                {
                    return;
                }
                string code = response.HasErrors ? null : response.ScriptData?.GetString("code");
                string delivery = response.HasErrors ? null : response.ScriptData?.GetString("delivery");
                Communitan.logger.LogInfo($"Activation code request: delivery={delivery ?? "-"} code={(string.IsNullOrEmpty(code) ? "no" : "yes")} error={response.HasErrors}");
                if (delivery == "auto")
                {
                    SetLine(screen, "Activating ...");
                    screen.inputCode.text = string.IsNullOrEmpty(code) ? "00000" : code;
                    screen.activateButton.onClick.Invoke();
                }
                else if (!string.IsNullOrEmpty(code))
                {
                    screen.inputCode.text = code;
                    SetLine(screen, $"This community server doesn't send emails. Your activation code: {code}");
                }
                else
                {
                    SetLine(screen, "This community server doesn't send emails and returned no activation code. Ask its operator.");
                }
            });
        }

        private static void SetLine(RegisterStep2ScreenRework screen, string text)
        {
            try
            {
                Transform existing = screen.transform.Find(LineName);
                TMP_Text label = existing != null ? existing.GetComponent<TMP_Text>()
                    : text == null ? null : LoginHints.CreateLabel(screen.transform, screen.hintText != null ? screen.hintText.GetComponent<TMP_Text>() : null, LineName, 470f);
                if (label != null)
                {
                    label.text = text ?? "";
                    label.gameObject.SetActive(text != null);
                }
            }
            catch (System.Exception e)
            {
                Communitan.logger.LogWarning($"Cannot show the activation code line: {e.Message}");
            }
        }
    }
}
