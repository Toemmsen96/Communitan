using Common;
using Common.IngameMenu;
using Common.Net;
using GameHub.Screens;
using HarmonyLib;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Communitan
{
    // "Leave game" button on the versus/loading screen. The game offers no way out there (its own back button is always
    // hidden, and GameRoot.OnBackToMainMenu ignores it once the match counts as running), so a rejoin into a session that
    // never starts (broken/desynced game, peers gone, history that no longer applies) is a dead end until the game is killed.
    // Own overlay canvas (the game can't hide it): shown while the loading screen is up (CatanLoadingScreen.IsShowingLoader), at once when rejoining, after
    // StuckSeconds otherwise. Click = the game's full exit (IngameUtils.ExitGame: FinishGame/CancelMatch, SendPlayerExitGame,
    // main menu); main menu loaded directly if the exit doesn't (not in the game scene / an earlier exit got stuck).
    public class RejoinCancel : MonoBehaviour
    {
        private const float StuckSeconds = 20f;
        private float versusSince = -1f;
        private float nextCheck;
        private GameObject root;

        private void Update()
        {
            if (Time.unscaledTime < nextCheck)
            {
                return;
            }
            nextCheck = Time.unscaledTime + 0.5f;
            bool show = false;
            // The VersusScreen object stays active in menus and in game; the loader flag says whether it is on screen.
            MatchConnectController match = CommonNetworking.Instance?.MatchConnecting;
            if (CatanLoadingScreen.IsShowingLoader && FindObjectOfType<VersusScreen>() != null && match != null)
            {
                if (versusSince < 0f)
                {
                    versusSince = Time.unscaledTime;
                }
                show = match.State == MatchState.Rejoin || Time.unscaledTime - versusSince >= StuckSeconds;
            }
            else
            {
                versusSince = -1f;
            }
            if (show && root == null && !Create())
            {
                return;
            }
            if (root != null && root.activeSelf != show)
            {
                root.SetActive(show);
                if (show)
                {
                    Communitan.logger.LogInfo($"RejoinCancel: 'Leave game' shown (state {match?.State})");
                }
            }
        }

        private bool Create()
        {
            TMP_Text source = ServerInfoOverlay.FindGameText();
            if (source == null)
            {
                return false;
            }
            root = new GameObject("Communitan_LeaveGame");
            DontDestroyOnLoad(root);
            Canvas canvas = root.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 32001;
            CanvasScaler scaler = root.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 0.5f;
            root.AddComponent<GraphicRaycaster>();

            GameObject buttonGo = new GameObject("Communitan_LeaveGameButton");
            buttonGo.transform.SetParent(root.transform, false);
            Image bg = buttonGo.AddComponent<Image>();
            bg.color = new Color(0.16f, 0.04f, 0.03f, 0.92f);
            Button button = buttonGo.AddComponent<Button>();
            button.targetGraphic = bg;
            button.onClick.AddListener(Leave);
            RectTransform rt = buttonGo.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 1f);
            rt.anchoredPosition = new Vector2(0f, -18f);
            rt.sizeDelta = new Vector2(280f, 54f);

            GameObject textGo = new GameObject("Communitan_LeaveGameText");
            textGo.transform.SetParent(buttonGo.transform, false);
            TextMeshProUGUI label = textGo.AddComponent<TextMeshProUGUI>();
            label.font = source.font;
            label.fontSharedMaterial = source.fontSharedMaterial;
            label.fontSize = 24f;
            label.color = new Color(0.96f, 0.69f, 0.2f, 1f);
            label.alignment = TextAlignmentOptions.Center;
            label.raycastTarget = false;
            label.text = "Leave game";
            RectTransform lt = label.rectTransform;
            lt.anchorMin = Vector2.zero;
            lt.anchorMax = Vector2.one;
            lt.offsetMin = lt.offsetMax = Vector2.zero;
            root.SetActive(false);
            return true;
        }

        private void Leave()
        {
            Communitan.logger.LogInfo($"RejoinCancel: leaving (state {CommonNetworking.Instance?.MatchConnecting?.State}, in game scene {SceneHelper.IsInGame})");
            root.SetActive(false);
            versusSince = -1f;
            AccessTools.Field(typeof(IngameUtils), "isExitingGame")?.SetValue(null, false); // an earlier exit may have stuck
            bool inGameScene = SceneHelper.IsInGame;
            IngameUtils.ExitGame("Communitan.LeaveGame");
            if (!inGameScene)
            {
                AccessTools.Method(typeof(IngameUtils), "ExitGameInternally")?.Invoke(null, null); // loads the main menu
            }
        }
    }
}
