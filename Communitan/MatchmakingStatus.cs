using Common.Net;
using GameHub.Screens;
using HarmonyLib;
using System;
using System.Linq;
using System.Threading.Tasks;
using TMPro;
using UnityEngine;
using UnityGameBase.Core.XUI;

namespace Communitan
{
    // While a quick/auto match search runs on a custom server: one extra line under the game's "searching" text
    // (CommonWaitForMultiplayerGameScreen, refs.playersFoundText) with the public counts for the searched mode, refreshed
    // every 5 s from COMMUNITAN_STATUS (docs/protocol/core.md 5.4). Falls back to an IMGUI line if that screen is not shown.
    public class MatchmakingStatus : MonoBehaviour
    {
        private const float RefreshSeconds = 5f;

        private string modeKey, text;
        private float nextCheck, nextFetch;
        private volatile bool fetching, loggedFirst;
        private volatile ServerStatus latest;
        private TMP_Text anchor, line;
        private GUIStyle fallbackStyle;
        private bool showFallback;

        // Same key the server builds from the matchmaker add: matchType|expansions sorted (ordinal), comma-joined|min-max.
        internal static string ModeKey(MultiplayerGameInformation gi)
        {
            string expansions = string.Join(",", gi.SelectedExpansions.Select(e => e.ToString()).OrderBy(e => e, StringComparer.Ordinal));
            return $"{gi.Match}|{expansions}|{gi.MinPlayers}-{gi.MaxPlayers}";
        }

        private static bool Searching(out MultiplayerGameInformation gi)
        {
            gi = null;
            CommonNetworking net = CommonNetworking.Instance;
            if (net == null || net.MatchConnecting == null || !ServerList.IsCustomSelected)
            {
                return false;
            }
            MatchState state = net.MatchConnecting.State;
            if (state != MatchState.StartMatchmaking && state != MatchState.WaitForMatch)
            {
                return false;
            }
            gi = net.MatchConnecting.GameInfo;
            return gi != null && (gi.Match == MatchType.QUICK_MATCH || gi.Match == MatchType.AUTO_MATCH);
        }

        private void Update()
        {
            if (Time.unscaledTime < nextCheck)
            {
                return;
            }
            nextCheck = Time.unscaledTime + 0.5f;
            try
            {
                Tick();
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Matchmaking status: {e.Message}");
                nextCheck = Time.unscaledTime + 10f;
            }
        }

        private void Tick()
        {
            if (!Searching(out MultiplayerGameInformation gi))
            {
                if (modeKey != null)
                {
                    modeKey = null;
                    latest = null;
                    text = null;
                }
                Show(null);
                return;
            }
            string key = ModeKey(gi);
            if (key != modeKey)
            {
                modeKey = key;
                latest = null;
                nextFetch = 0f;
            }
            if (!fetching && Time.unscaledTime >= nextFetch)
            {
                nextFetch = Time.unscaledTime + RefreshSeconds;
                Fetch(ServerList.CurrentEntry);
            }
            ServerStatus status = latest;
            text = status == null ? null : $"Searching for this mode: {status.ModeSearching(modeKey)} · Playing this mode: {status.ModePlaying(modeKey)}";
            Show(text);
        }

        private void Fetch(ServerEntry entry)
        {
            if (entry == null)
            {
                return;
            }
            fetching = true;
            string url = entry.Url, statusKey = entry.EffectiveStatusKey, key = modeKey;
            Task.Run(async () =>
            {
                try
                {
                    ServerStatus status = await ServerPing.FetchStatus(url, statusKey).ConfigureAwait(false);
                    if (status != null)
                    {
                        latest = status;
                        if (!loggedFirst)
                        {
                            loggedFirst = true;
                            Communitan.logger.LogInfo($"Matchmaking status for {key}: searching {status.ModeSearching(key)}, playing {status.ModePlaying(key)} (server: {status.Online} online)");
                        }
                    }
                }
                finally
                {
                    fetching = false;
                }
            });
        }

        // Native line under the screen's "searching for players" text; IMGUI fallback when that text is not visible.
        private void Show(string value)
        {
            TMP_Text target = value == null ? null : FindAnchor();
            if (target != null && (line == null || anchor != target))
            {
                CreateLine(target);
            }
            if (line != null)
            {
                bool visible = value != null && target != null;
                if (line.gameObject.activeSelf != visible)
                {
                    line.gameObject.SetActive(visible);
                }
                if (visible)
                {
                    line.text = value;
                }
            }
            showFallback = value != null && target == null;
        }

        private static TMP_Text FindAnchor()
        {
            CommonWaitForMultiplayerGameScreen screen = FindObjectOfType<CommonWaitForMultiplayerGameScreen>(true);
            if (screen == null || !screen.IsShowing)
            {
                return null;
            }
            CommonWaitForMultiplayerGameReferences refs = Traverse.Create(screen).Field("refs").GetValue<CommonWaitForMultiplayerGameReferences>();
            LocalizedTMPComponent localized = refs != null ? refs.playersFoundText : null;
            if (localized == null)
            {
                return null;
            }
            TMP_Text text = localized.GetComponent<TMP_Text>() ?? Traverse.Create(localized).Field("_text").GetValue<TMP_Text>();
            return text != null && text.gameObject.activeInHierarchy ? text : null;
        }

        private void CreateLine(TMP_Text target)
        {
            if (line != null)
            {
                Destroy(line.gameObject);
            }
            anchor = target;
            GameObject clone = Instantiate(target.gameObject, target.transform.parent, false);
            clone.name = "Communitan_MatchmakingStatus";
            foreach (LocalizedTMPComponent localized in clone.GetComponentsInChildren<LocalizedTMPComponent>(true))
            {
                DestroyImmediate(localized);
            }
            foreach (TMP_Localization localized in clone.GetComponentsInChildren<TMP_Localization>(true))
            {
                DestroyImmediate(localized);
            }
            clone.transform.SetSiblingIndex(target.transform.GetSiblingIndex() + 1);
            line = clone.GetComponent<TMP_Text>();
            line.enableAutoSizing = false;
            line.fontSize = Mathf.Max(16f, target.fontSize * 0.6f);
            line.fontStyle &= ~FontStyles.UpperCase;
            line.enableWordWrapping = false;
            line.overflowMode = TextOverflowModes.Overflow;
            line.raycastTarget = false;
            Color c = target.color;
            line.color = new Color(c.r, c.g, c.b, c.a * 0.85f);
            // Without a layout group on the parent: place it right below the original text.
            if (target.transform.parent == null || target.transform.parent.GetComponent<UnityEngine.UI.LayoutGroup>() == null)
            {
                RectTransform src = target.rectTransform, dst = line.rectTransform;
                dst.anchoredPosition = src.anchoredPosition + new Vector2(0f, -Mathf.Max(src.rect.height * 0.75f, line.fontSize * 1.6f));
            }
            Communitan.logger.LogInfo($"Matchmaking status line attached under '{target.name}' ({target.transform.parent?.name})");
        }

        private void OnGUI()
        {
            if (!showFallback || string.IsNullOrEmpty(text))
            {
                return;
            }
            if (fallbackStyle == null)
            {
                fallbackStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, richText = true, wordWrap = false };
            }
            fallbackStyle.fontSize = Mathf.Max(14, Screen.height / 45);
            Rect rect = new Rect(0f, Screen.height * 0.86f, Screen.width, fallbackStyle.fontSize * 2f);
            GUI.Label(new Rect(rect.x + 2f, rect.y + 2f, rect.width, rect.height), $"<color=#000000cc>{text}</color>", fallbackStyle);
            GUI.Label(rect, $"<color=#f3e6c4>{text}</color>", fallbackStyle);
        }
    }
}
