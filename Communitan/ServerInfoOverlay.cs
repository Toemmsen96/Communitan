using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Communitan
{
    // One line at the bottom left: mod version + the server the game talks to (cfg UI.ShowServerInfo). TextMeshPro with
    // the game's own UI font (taken from a live game text), on an own overlay canvas so it survives scene changes.
    public class ServerInfoOverlay : MonoBehaviour
    {
        private TextMeshProUGUI label;
        private float nextRefresh;

        private void Update()
        {
            if (Time.unscaledTime < nextRefresh)
            {
                return;
            }
            nextRefresh = Time.unscaledTime + 1f;
            if (label == null && !TryCreate())
            {
                return;
            }
            label.gameObject.SetActive(Communitan.showServerInfo.Value);
            label.text = $"Communitan {Communitan.Version} · {ServerText()}";
        }

        private static string ServerText()
        {
            if (Patches.Patches.EnvOverride != null)
            {
                return "/setenv " + ServerList.Endpoint(Patches.Patches.EnvOverride);
            }
            if (ServerList.IsCustomSelected)
            {
                ServerEntry entry = ServerList.CurrentEntry;
                return $"{entry.Name} ({entry.Address})";
            }
            return ServerList.OfficialName;
        }

        // Font + material of the game's most used UI text font (Roboto Condensed family where present); null until a menu is up.
        internal static TMP_Text FindGameText()
        {
            TMP_Text best = null;
            int bestScore = -1;
            Dictionary<TMP_FontAsset, int> uses = new Dictionary<TMP_FontAsset, int>();
            foreach (TextMeshProUGUI t in FindObjectsOfType<TextMeshProUGUI>())
            {
                if (t.font == null || t.name.StartsWith("Communitan"))
                {
                    continue;
                }
                uses.TryGetValue(t.font, out int n);
                uses[t.font] = n + 1;
                int score = (n + 1) + (t.font.name.Contains("Roboto") ? 1000 : 0) + (t.font.name.Contains("Bold") ? -500 : 0);
                if (score > bestScore)
                {
                    best = t;
                    bestScore = score;
                }
            }
            return best;
        }

        private bool TryCreate()
        {
            TMP_Text source = FindGameText();
            if (source == null)
            {
                return false;
            }
            GameObject root = new GameObject("Communitan_ServerInfo");
            DontDestroyOnLoad(root);
            Canvas canvas = root.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 32000;
            CanvasScaler scaler = root.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 0.5f;

            GameObject go = new GameObject("Communitan_ServerInfoText");
            go.transform.SetParent(root.transform, false);
            label = go.AddComponent<TextMeshProUGUI>();
            label.font = source.font;
            label.fontSharedMaterial = source.fontSharedMaterial;
            label.fontSize = 20f;
            label.color = new Color(0.953f, 0.902f, 0.769f, 0.85f);
            label.alignment = TextAlignmentOptions.BottomLeft;
            label.enableWordWrapping = false;
            label.overflowMode = TextOverflowModes.Overflow;
            label.raycastTarget = false;
            RectTransform rt = label.rectTransform;
            rt.anchorMin = rt.anchorMax = rt.pivot = Vector2.zero;
            rt.anchoredPosition = new Vector2(14f, 8f);
            rt.sizeDelta = new Vector2(1200f, 30f);
            Communitan.logger.LogInfo($"Server info line uses font '{source.font.name}'");
            return true;
        }
    }
}
