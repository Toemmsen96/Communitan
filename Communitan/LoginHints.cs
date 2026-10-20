using GameHub.Screens;
using HarmonyLib;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UiRework;
using UnityEngine;

namespace Communitan
{
    // While a custom server is selected, the game's login and register screens show a one-line password warning,
    // styled from the screen's own hint text.
    internal static class LoginHints
    {
        internal const string Text = "Community server — do not use your official password.";
        private const string Name = "Communitan_PasswordHint";
        private static readonly List<TMP_Text> hints = new List<TMP_Text>();

        [HarmonyPatch(typeof(LoginScreenRework), "Show")]
        [HarmonyPostfix]
        private static void OnLoginShow(LoginScreenRework __instance)
        {
            Ensure(__instance.transform, __instance.hintText != null ? __instance.hintText.GetComponent<TMP_Text>() : null, 470f);
        }

        [HarmonyPatch(typeof(RegisterScreenRework), "Show")]
        [HarmonyPostfix]
        private static void OnRegisterShow(RegisterScreenRework __instance)
        {
            Ensure(__instance.transform, __instance.hintText != null ? __instance.hintText.GetComponent<TMP_Text>() : null, 470f);
        }

        private static void Ensure(Transform screen, TMP_Text template, float bottomOffset)
        {
            try
            {
                if (screen.Find(Name) == null)
                {
                    TMP_Text label = CreateLabel(screen, template, Name, bottomOffset);
                    label.text = Text;
                    hints.Add(label);
                }
                Refresh();
            }
            catch (System.Exception e)
            {
                Communitan.logger.LogWarning($"Cannot add the password hint to {screen.name}: {e.Message}");
            }
        }

        // One-line label in the screen's own text style (cloned from template), centered bottomOffset above the bottom.
        internal static TMP_Text CreateLabel(Transform screen, TMP_Text template, string name, float bottomOffset)
        {
            template = template ?? screen.GetComponentsInChildren<TMP_Text>(true).FirstOrDefault();
            GameObject clone = Object.Instantiate(template.gameObject, screen, false);
            clone.name = name;
            foreach (Component c in clone.GetComponents<Component>().Where(c => c != null && c.GetType().Name.Contains("Locali")))
            {
                Object.DestroyImmediate(c);
            }
            foreach (Transform child in clone.transform.Cast<Transform>().ToList())
            {
                Object.DestroyImmediate(child.gameObject);
            }
            TMP_Text label = clone.GetComponent<TMP_Text>();
            RectTransform rect = label.rectTransform;
            rect.anchorMin = rect.anchorMax = new Vector2(0.5f, 0f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.sizeDelta = new Vector2(2400f, 90f);
            rect.anchoredPosition = new Vector2(0f, bottomOffset);
            label.enableAutoSizing = false;
            label.fontSize = 44f;
            label.fontStyle = FontStyles.Bold;
            label.alignment = TextAlignmentOptions.Center;
            label.enableWordWrapping = false;
            label.color = new Color(1f, 0.83f, 0.35f);
            clone.SetActive(true);
            return label;
        }

        internal static void Refresh()
        {
            hints.RemoveAll(h => h == null);
            bool show = ServerList.IsCustomSelected;
            foreach (TMP_Text hint in hints)
            {
                hint.gameObject.SetActive(show);
            }
        }
    }
}
