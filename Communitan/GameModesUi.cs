using Common;
using Common.GameLogic;
using Common.Net;
using Common.Unity;
using Communitan.Rules;
using GameHub.Handlers;
using GameHub.Screens;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using TMPro;
using UiRework;
using UnityEngine;
using UnityEngine.UI;

namespace Communitan
{
    // A game mode offered by the selected custom server (RPC COMMUNITAN_MODES, server/src/modes.ts).
    internal sealed class ModeInfo
    {
        public string Id, Name, Description;
        public int Min, Max;
        public List<string> Expansions;
        public JObject GameInfo;

        public bool BaseGameOnly => Expansions.Count == 1 && Expansions[0] == "CatanBaseGame";

        public string Players => Min == Max ? $"{Min} players" : $"{Min}-{Max} players";
    }

    // Modes of the selected custom server, fetched with the public status key (no login needed) whenever the server changes
    // or a login happens, then every 10 minutes. Official servers: always empty.
    internal static class ModeList
    {
        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
        private static List<ModeInfo> modes = new List<ModeInfo>();
        private static string url;
        private static bool fetching, authed;
        private static float nextFetch;

        internal static int Version { get; private set; }

        internal static List<ModeInfo> Modes => ServerList.IsCustomSelected && GameModes.PatchesOk ? modes : new List<ModeInfo>();

        internal static ModeInfo Find(string id) => id == null ? null : Modes.FirstOrDefault(m => m.Id == id);

        internal static void Tick()
        {
            ServerEntry entry = ServerList.IsCustomSelected ? ServerList.CurrentEntry : null;
            string u = entry?.Url;
            bool a = CommonNetworking.Instance?.Authentication != null && CommonNetworking.Instance.Authentication.IsAuthenticated;
            if (u != url || (a && !authed))
            {
                url = u;
                nextFetch = 0f;
                if (u == null && modes.Count > 0)
                {
                    modes = new List<ModeInfo>();
                    Version++;
                }
            }
            authed = a;
            if (u == null || fetching || Time.unscaledTime < nextFetch)
            {
                return;
            }
            nextFetch = Time.unscaledTime + 600f;
            fetching = true;
            string key = entry.EffectiveStatusKey;
            Task.Run(async () =>
            {
                try
                {
                    List<ModeInfo> list = await Fetch(u, key).ConfigureAwait(false);
                    if (list != null && u == url)
                    {
                        bool changed = string.Join(",", list.Select(m => m.Id + "/" + m.Name).ToArray()) != string.Join(",", modes.Select(m => m.Id + "/" + m.Name).ToArray());
                        modes = list;
                        if (changed)
                        {
                            Version++;
                            Communitan.logger.LogInfo($"GameModes: server offers {(list.Count == 0 ? "no modes" : string.Join(", ", list.Select(m => $"{m.Id} ({m.Name}, {m.Players})").ToArray()))}");
                        }
                    }
                }
                finally
                {
                    fetching = false;
                }
            });
        }

        private static async Task<List<ModeInfo>> Fetch(string baseUrl, string statusKey)
        {
            try
            {
                string uri = $"{baseUrl.TrimEnd('/')}/v2/rpc/COMMUNITAN_MODES?http_key={Uri.EscapeDataString(statusKey)}&unwrap";
                using (HttpResponseMessage response = await http.GetAsync(uri).ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode)
                    {
                        return new List<ModeInfo>(); // older server without modes
                    }
                    JObject o = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
                    List<ModeInfo> list = new List<ModeInfo>();
                    foreach (JObject m in (o["modes"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string id = (string)m["id"];
                        if (!GameModes.ValidId(id))
                        {
                            continue;
                        }
                        list.Add(new ModeInfo
                        {
                            Id = id,
                            Name = string.IsNullOrEmpty((string)m["name"]) ? id : (string)m["name"],
                            Description = (string)m["description"] ?? "",
                            Min = (int?)m["players"]?["min"] ?? 2,
                            Max = (int?)m["players"]?["max"] ?? 4,
                            Expansions = (m["expansions"] as JArray)?.Select(x => (string)x).ToList() ?? new List<string>(),
                            GameInfo = m["gameInfo"] as JObject ?? new JObject(),
                        });
                    }
                    return list;
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogDebug($"GameModes: mode list from {baseUrl} failed: {e.GetBaseException().Message}");
                return null;
            }
        }
    }

    // UI of server-defined game modes (docs/design/game-modes.md G2), custom servers only (Official: no modes, no changes):
    //  - lobby: "Game mode" cycler cloned from the scenario settings' Random map toggle (host only); writes the mode id into
    //    the lobby game info (GameModes.SetQueued -> ToGSData ccsMode -> LOBBY_UPDATE_GAME_INFO / LOBBY_START_GAME / CreateChallenge)
    //  - Free Play: one box per mode cloned from the Free Play box (Freeplay_Box), its Play starts Free Play in that mode
    //  - mode name: versus screen (map line), invite dialog, and an overlay line in the lobby / while searching / loading / in game
    public class GameModesUi : MonoBehaviour
    {
        private const string ToggleName = "Communitan_ModeToggle";
        private const string BoxPrefix = "Communitan_ModeBox_";
        private static readonly Color Gold = new Color(0.96f, 0.69f, 0.2f, 1f);

        private static BoxButtonWrapper freePlaySource;
        private static int boxesVersion = -1;
        private static bool building;
        private static ScenarioSettingsWithBots settings;
        private static float settingsSpacing = -1f;
        private static readonly Dictionary<Selectable, bool> locked = new Dictionary<Selectable, bool>();

        private TextMeshProUGUI label;
        private float nextTick;

        private void Update()
        {
            if (Time.unscaledTime < nextTick)
            {
                return;
            }
            nextTick = Time.unscaledTime + 0.5f;
            try
            {
                ModeList.Tick();
                FindFreePlaySource();
                if (freePlaySource != null && (boxesVersion != ModeList.Version || BoxesOutOfSync()))
                {
                    SyncBoxes(freePlaySource);
                }
                if (settings != null && settings.gameObject.activeInHierarchy)
                {
                    RefreshSelector(settings, null);
                }
                UpdateLabel();
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes UI: {e.Message}");
                nextTick = Time.unscaledTime + 5f;
            }
        }

        // ---- overlay line ---------------------------------------------------------------------------------

        private static string LabelText()
        {
            if (!ServerList.IsCustomSelected)
            {
                return null;
            }
            MatchConnectController mc = CommonNetworking.Instance?.MatchConnecting;
            if (mc == null)
            {
                return null;
            }
            ModeDef cur = GameModes.CurrentFor(mc.GameInfo);
            if (cur != null && (SceneHelper.IsInGame || CatanLoadingScreen.IsShowingLoader))
            {
                return "Game mode: " + (string.IsNullOrEmpty(cur.Name) ? cur.Id : cur.Name);
            }
            if (!SceneHelper.IsInMainMenu)
            {
                return null;
            }
            string id = GameModes.QueuedMode(mc.GameInfo);
            Lobby lobby = CommonNetworking.Instance.Lobby;
            if (id == null || !(lobby != null && lobby.IsInLobby || mc.IsMakingMatch))
            {
                return null;
            }
            ModeInfo m = ModeList.Find(id);
            string what = lobby != null && lobby.IsInLobby ? "Lobby game mode" : "Searching game mode";
            return m == null ? $"{what}: {id}" : $"{what}: {m.Name} ({m.Players})\n<size=75%>{m.Description}</size>";
        }

        private void UpdateLabel()
        {
            string text = LabelText();
            if (text == null)
            {
                if (label != null && label.gameObject.activeSelf)
                {
                    label.gameObject.SetActive(false);
                }
                return;
            }
            if (label == null && !CreateLabel())
            {
                return;
            }
            if (!label.gameObject.activeSelf)
            {
                label.gameObject.SetActive(true);
            }
            if (label.text != text)
            {
                label.text = text;
                Communitan.logger.LogInfo($"GameModes: mode line '{text.Replace("\n", " / ")}'");
            }
        }

        // Own overlay canvas (like ServerInfoOverlay) above the server info line, bottom left.
        private bool CreateLabel()
        {
            TMP_Text source = ServerInfoOverlay.FindGameText();
            if (source == null)
            {
                return false;
            }
            GameObject root = new GameObject("Communitan_ModeInfo");
            DontDestroyOnLoad(root);
            Canvas canvas = root.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 32000;
            CanvasScaler scaler = root.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.matchWidthOrHeight = 0.5f;
            GameObject go = new GameObject("Communitan_ModeInfoText");
            go.transform.SetParent(root.transform, false);
            label = go.AddComponent<TextMeshProUGUI>();
            label.font = source.font;
            label.fontSharedMaterial = source.fontSharedMaterial;
            label.fontSize = 26f;
            label.fontStyle = FontStyles.Bold;
            label.color = Gold;
            label.alignment = TextAlignmentOptions.BottomLeft;
            label.enableWordWrapping = true;
            label.overflowMode = TextOverflowModes.Overflow;
            label.raycastTarget = false;
            label.outlineWidth = 0.15f;
            label.outlineColor = new Color32(0, 0, 0, 200);
            RectTransform rt = label.rectTransform;
            rt.anchorMin = rt.anchorMax = rt.pivot = Vector2.zero;
            rt.anchoredPosition = new Vector2(14f, 36f);
            rt.sizeDelta = new Vector2(900f, 80f);
            return true;
        }

        // ---- lobby: "Game mode" cycler in the scenario settings ------------------------------------------------

        private static bool HostCanPick()
        {
            Lobby lobby = CommonNetworking.Instance?.Lobby;
            return ServerList.IsCustomSelected && GameModes.PatchesOk && lobby != null && lobby.IsInLobby && lobby.IsLocalPlayerOwner
                && CommonNetworking.Instance.MatchConnecting?.GameInfo != null;
        }

        // The game recomputes its controls: give them back their own state first (the postfix locks them again).
        [HarmonyPatch(typeof(ScenarioSettingsWithBots), nameof(ScenarioSettingsWithBots.UpdateWithScenarioAndSetSingleplayer))]
        [HarmonyPrefix]
        private static void BeforeScenarioSettings()
        {
            foreach (Selectable c in locked.Keys.ToList())
            {
                Unlock(c);
            }
        }

        [HarmonyPatch(typeof(ScenarioSettingsWithBots), nameof(ScenarioSettingsWithBots.UpdateWithScenarioAndSetSingleplayer))]
        [HarmonyPostfix]
        private static void OnScenarioSettings(ScenarioSettingsWithBots __instance, ScenarioData scenarioData)
        {
            try
            {
                settings = __instance;
                RefreshSelector(__instance, scenarioData);
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: lobby mode selector failed: {e}");
            }
        }

        private static bool baseScenario;

        // scenarioData null = periodic refresh (keeps the last scenario's expansion).
        private static void RefreshSelector(ScenarioSettingsWithBots s, ScenarioData scenarioData)
        {
            if (scenarioData != null)
            {
                baseScenario = scenarioData.DefaultData != null && scenarioData.DefaultData.MainExpansion == ExpansionsEnum.CatanBaseGame;
            }
            MultiplayerGameInformation gi = CommonNetworking.Instance?.MatchConnecting?.GameInfo;
            List<ModeInfo> modes = ModeList.Modes.Where(m => m.BaseGameOnly).ToList();
            bool show = HostCanPick() && baseScenario && modes.Count > 0;
            Toggle toggle = s.transform.Find(ToggleName)?.GetComponent<Toggle>();
            if (!show)
            {
                if (toggle != null && toggle.gameObject.activeSelf)
                {
                    toggle.gameObject.SetActive(false);
                    Fit(s);
                }
                // lobby switched to another expansion: no mode (the server would drop it too)
                if (scenarioData != null && HostCanPick() && !baseScenario && GameModes.QueuedMode(gi) != null)
                {
                    SetMode(s, gi, null, false);
                }
                return;
            }
            if (toggle == null)
            {
                toggle = CreateToggle(s);
            }
            if (!toggle.gameObject.activeSelf)
            {
                toggle.gameObject.SetActive(true);
            }
            ModeInfo current = ModeList.Find(GameModes.QueuedMode(gi));
            if (current == null && GameModes.QueuedMode(gi) != null)
            {
                SetMode(s, gi, null, true); // mode no longer offered
                return;
            }
            Render(s, toggle, current);
            Fit(s);
        }

        private static Toggle CreateToggle(ScenarioSettingsWithBots s)
        {
            Toggle source = Traverse.Create(s).Field("_randomMapToggle").GetValue<Toggle>() ?? throw new InvalidOperationException("no _randomMapToggle");
            GameObject go = Instantiate(source.gameObject, source.transform.parent, false);
            go.name = ToggleName;
            foreach (TMP_Localization loc in go.GetComponentsInChildren<TMP_Localization>(true))
            {
                DestroyImmediate(loc);
            }
            go.transform.SetSiblingIndex(0);
            Toggle toggle = go.GetComponent<Toggle>();
            toggle.group = null;
            toggle.onValueChanged = new Toggle.ToggleEvent();
            toggle.interactable = true;
            toggle.onValueChanged.AddListener(_ => OnToggleClicked(s));
            Communitan.logger.LogInfo($"GameModes: lobby mode selector created under {Path(go.transform.parent)} (index 0, size {((RectTransform)go.transform).rect.size})");
            return toggle;
        }

        private static void OnToggleClicked(ScenarioSettingsWithBots s)
        {
            MultiplayerGameInformation gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            List<ModeInfo> modes = ModeList.Modes.Where(m => m.BaseGameOnly).ToList();
            int i = modes.FindIndex(m => m.Id == GameModes.QueuedMode(gi)); // -1 = Standard
            ModeInfo next = i + 1 < modes.Count ? modes[i + 1] : null;
            SetMode(s, gi, next, true);
        }

        // Host picks a mode (null = Standard): game info + visible overrides, then the lobby update (others see it).
        internal static void SetMode(ScenarioSettingsWithBots s, MultiplayerGameInformation gi, ModeInfo mode, bool send)
        {
            GameModes.SetQueued(gi, mode?.Id);
            ApplyOverrides(s, gi, mode);
            Toggle toggle = s.transform.Find(ToggleName)?.GetComponent<Toggle>();
            if (toggle != null)
            {
                Render(s, toggle, mode);
            }
            Communitan.logger.LogInfo($"GameModes: lobby mode -> {(mode == null ? "Standard" : mode.Id)}");
            if (send)
            {
                CommonNetworking.Instance.Lobby.UpdateGameInfoIfHost();
            }
        }

        private static void Render(ScenarioSettingsWithBots s, Toggle toggle, ModeInfo mode)
        {
            toggle.SetIsOnWithoutNotify(mode != null);
            TMP_Text text = toggle.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>() ?? toggle.GetComponentInChildren<TMP_Text>(true);
            if (text != null)
            {
                string value = mode == null ? "Game mode: Standard" : $"Game mode: <b>{mode.Name}</b>";
                if (text.text != value)
                {
                    text.text = value;
                }
            }
            TMP_Text info = toggle.transform.Find("InfoPopup/InfoText")?.GetComponent<TMP_Text>();
            if (info != null)
            {
                info.text = mode == null
                    ? "Custom game modes of this server. Click to switch: Standard, " + string.Join(", ", ModeList.Modes.Where(m => m.BaseGameOnly).Select(m => m.Name).ToArray()) + "."
                    : $"{mode.Name} ({mode.Players}): {mode.Description}";
            }
            ApplyOverrides(s, CommonNetworking.Instance.MatchConnecting.GameInfo, mode);
        }

        // The mode's gameInfo keys (server overrides them anyway): shown on the game's own controls, which are locked meanwhile.
        private static void ApplyOverrides(ScenarioSettingsWithBots s, MultiplayerGameInformation gi, ModeInfo mode)
        {
            Traverse t = Traverse.Create(s);
            JObject o = mode?.GameInfo ?? new JObject();
            Override(t.Field("_randomMapToggle").GetValue<Toggle>(), o["useShuffleMap"], v => gi.UseShuffleMap = v);
            Override(t.Field("_friendlyRobberToggle").GetValue<Toggle>(), o["friendlyRobber"], v => gi.FriendlyRobber = v);
            Override(t.Field("_cardModeToggle").GetValue<Toggle>(), o["diceMode"], v => gi.DiceMode = v);
            Slider vp = t.Field("_victoryPointSlider").GetValue<Slider>();
            JToken vpv = o["victoryPoints"];
            if (vp != null && vpv != null && vpv.Type == JTokenType.Integer)
            {
                Lock(vp);
                int points = (int)vpv;
                if (gi.VictoryPoints != points)
                {
                    gi.VictoryPoints = points;
                    vp.SetValueWithoutNotify(points - t.Field("defaultVictoryPoints").GetValue<int>());
                    t.Method("UpdateVictoryPointsText", points).GetValue();
                }
            }
            else if (vp != null)
            {
                Unlock(vp);
            }
        }

        private static void Override(Toggle toggle, JToken value, Action<bool> set)
        {
            if (toggle == null)
            {
                return;
            }
            if (value == null || value.Type != JTokenType.Boolean)
            {
                Unlock(toggle);
                return;
            }
            Lock(toggle);
            bool v = (bool)value;
            set(v);
            if (toggle.isOn != v)
            {
                toggle.SetIsOnWithoutNotify(v);
            }
        }

        private static void Lock(Selectable c)
        {
            if (!locked.ContainsKey(c))
            {
                locked[c] = c.interactable;
                c.interactable = false;
            }
        }

        private static void Unlock(Selectable c)
        {
            if (locked.TryGetValue(c, out bool was))
            {
                c.interactable = was;
                locked.Remove(c);
            }
        }

        // The settings column has a fixed height: with the extra row (and the turn timer slider) shrink the spacing to fit.
        private static void Fit(ScenarioSettingsWithBots s)
        {
            VerticalLayoutGroup layout = s.GetComponent<VerticalLayoutGroup>();
            if (layout == null)
            {
                return;
            }
            if (settingsSpacing < 0f)
            {
                settingsSpacing = layout.spacing;
            }
            float height = ((RectTransform)s.transform).rect.height - layout.padding.top - layout.padding.bottom;
            List<RectTransform> rows = s.transform.Cast<Transform>().Where(c => c.gameObject.activeSelf && !(c.GetComponent<LayoutElement>()?.ignoreLayout ?? false)).Cast<RectTransform>().ToList();
            float sum = rows.Sum(r => r.rect.height);
            float spacing = rows.Count > 1 ? Mathf.Clamp((height - sum) / (rows.Count - 1), 0f, settingsSpacing) : settingsSpacing;
            if (Mathf.Abs(layout.spacing - spacing) > 0.5f)
            {
                layout.spacing = spacing;
                LayoutRebuilder.MarkLayoutForRebuild((RectTransform)s.transform);
            }
        }

        // ---- Free Play: one box per mode -------------------------------------------------------------------

        // Marks a cloned Free Play box.
        public class ModeBox : MonoBehaviour
        {
            public string ModeId;
        }

        private static ConnectionState connectionState;

        private static bool ShowBoxes()
        {
            if (connectionState == null)
            {
                connectionState = FindObjectOfType<ConnectionState>(true);
            }
            ConnectionState cs = connectionState;
            return ServerList.IsCustomSelected && GameModes.PatchesOk && cs != null && cs.LobbyState == ConnectionState.LobbyStateEnum.Multiplayer;
        }

        private static bool IsFreePlayBox(BoxButtonWrapper w)
        {
            GamemodeData d = Traverse.Create(w).Field("_gamemodeData").GetValue<GamemodeData>();
            return d != null && d.expansion == ExpansionsEnum.CatanBaseGame && !d.IsFreeMatch && !d.isSeason
                && w.GetComponentsInChildren<Button>(true).Any(b => Enumerable.Range(0, b.onClick.GetPersistentEventCount()).Any(i => b.onClick.GetPersistentMethodName(i) == nameof(BoxButtonWrapper.PlayFreeMatch)));
        }

        // The Free Play box is switched on by Content's ObjectFreematchToggle.OnEnable (no OnEnable of the box itself then):
        // follow it from there, and poll as a fallback.
        [HarmonyPatch(typeof(ObjectFreematchToggle), "UpdateEnable")]
        [HarmonyPostfix]
        private static void OnFreematchToggle()
        {
            try
            {
                FindFreePlaySource();
                if (freePlaySource != null)
                {
                    SyncBoxes(freePlaySource);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: Free Play mode boxes failed: {e}");
            }
        }

        private static float nextSourceSearch;

        private static void FindFreePlaySource()
        {
            if (freePlaySource != null || Time.unscaledTime < nextSourceSearch || !SceneHelper.IsInMainMenu || !ServerList.IsCustomSelected)
            {
                return;
            }
            nextSourceSearch = Time.unscaledTime + 5f;
            freePlaySource = FindObjectsOfType<BoxButtonWrapper>(true).FirstOrDefault(w => w.GetComponent<ModeBox>() == null && IsFreePlayBox(w));
            if (freePlaySource != null)
            {
                Communitan.logger.LogInfo($"GameModes: Free Play box found: {Path(freePlaySource.transform)}");
            }
        }

        [HarmonyPatch(typeof(BoxButtonWrapper), "OnEnable")]
        [HarmonyPostfix]
        private static void OnBoxEnabled(BoxButtonWrapper __instance)
        {
            if (building)
            {
                return;
            }
            try
            {
                ModeBox marker = __instance.GetComponent<ModeBox>();
                if (marker != null)
                {
                    DecorateBox(__instance.gameObject, ModeList.Find(marker.ModeId));
                }
                else if (IsFreePlayBox(__instance))
                {
                    freePlaySource = __instance;
                    SyncBoxes(__instance);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: Free Play mode boxes failed: {e}");
            }
        }

        private static IEnumerable<ModeBox> Clones(Transform parent) => parent == null ? Enumerable.Empty<ModeBox>() : parent.Cast<Transform>().Select(c => c.GetComponent<ModeBox>()).Where(m => m != null);

        private static bool BoxesOutOfSync()
        {
            if (freePlaySource == null)
            {
                return false;
            }
            bool want = freePlaySource.gameObject.activeSelf && ShowBoxes();
            return Clones(freePlaySource.transform.parent).Any(c => c.gameObject.activeSelf != want);
        }

        private static void SyncBoxes(BoxButtonWrapper source)
        {
            boxesVersion = ModeList.Version;
            Transform parent = source.transform.parent;
            List<ModeInfo> modes = ShowBoxes() ? ModeList.Modes.Where(m => m.BaseGameOnly).ToList() : new List<ModeInfo>();
            List<ModeBox> clones = Clones(parent).ToList();
            foreach (ModeBox c in clones.Where(c => modes.All(m => m.Id != c.ModeId)))
            {
                c.gameObject.SetActive(false);
                Destroy(c.gameObject);
            }
            bool active = source.gameObject.activeSelf;
            int index = source.transform.GetSiblingIndex();
            foreach (ModeInfo m in modes)
            {
                ModeBox box = clones.FirstOrDefault(c => c != null && c.ModeId == m.Id);
                if (box == null)
                {
                    box = CreateBox(source, m);
                }
                box.transform.SetSiblingIndex(++index);
                if (box.gameObject.activeSelf != active)
                {
                    box.gameObject.SetActive(active);
                }
                DecorateBox(box.gameObject, m);
            }
        }

        private static ModeBox CreateBox(BoxButtonWrapper source, ModeInfo mode)
        {
            GameObject go;
            building = true;
            try
            {
                go = Instantiate(source.gameObject, source.transform.parent, false);
            }
            finally
            {
                building = false;
            }
            go.name = BoxPrefix + mode.Id;
            foreach (TMP_Localization loc in go.GetComponentsInChildren<TMP_Localization>(true))
            {
                DestroyImmediate(loc);
            }
            ModeBox marker = go.AddComponent<ModeBox>();
            marker.ModeId = mode.Id;
            DecorateBox(go, mode);
            RectTransform rt = (RectTransform)go.transform;
            Communitan.logger.LogInfo($"GameModes: Free Play box for mode {mode.Id} created under {Path(go.transform.parent)} (size {rt.rect.size})");
            return marker;
        }

        // Title = mode name, info strip = player count, (i) = description (the game's Free Play box hides both).
        private static void DecorateBox(GameObject box, ModeInfo mode)
        {
            if (mode == null)
            {
                return;
            }
            Transform button = box.transform.Find("Button");
            TMP_Text title = button?.Find("Titel")?.GetComponent<TMP_Text>();
            if (title != null && title.text != mode.Name)
            {
                title.text = mode.Name;
            }
            foreach (Transform info in button == null ? Enumerable.Empty<Transform>() : button.Cast<Transform>().Where(c => c.name == "Info"))
            {
                if (info.GetComponent<Button>() != null)
                {
                    info.gameObject.SetActive(true); // (i) -> OpenInfoScreen -> our dialog (OnOpenInfo)
                    continue;
                }
                TMP_Text strip = info.GetComponentInChildren<TMP_Text>(true);
                if (strip != null)
                {
                    strip.gameObject.SetActive(true);
                    string text = "Game mode · " + mode.Players;
                    if (strip.text != text)
                    {
                        strip.text = text;
                    }
                }
            }
        }

        [HarmonyPatch(typeof(BoxButtonWrapper), nameof(BoxButtonWrapper.PlayFreeMatch))]
        [HarmonyPrefix]
        private static void OnPlayFreeMatch(BoxButtonWrapper __instance)
        {
            ModeBox marker = __instance.GetComponent<ModeBox>();
            GameModes.PendingFreePlay = marker != null ? ModeList.Find(marker.ModeId) : null;
            if (marker != null)
            {
                Communitan.logger.LogInfo($"GameModes: Free Play box '{marker.ModeId}' clicked");
            }
        }

        [HarmonyPatch(typeof(BoxButtonWrapper), nameof(BoxButtonWrapper.PlayFreeMatch))]
        [HarmonyFinalizer]
        private static void AfterPlayFreeMatch()
        {
            GameModes.PendingFreePlay = null;
        }

        [HarmonyPatch(typeof(BoxButtonWrapper), nameof(BoxButtonWrapper.OpenInfoScreen))]
        [HarmonyPrefix]
        private static bool OnOpenInfo(BoxButtonWrapper __instance)
        {
            ModeBox marker = __instance.GetComponent<ModeBox>();
            if (marker == null)
            {
                return true;
            }
            ModeInfo m = ModeList.Find(marker.ModeId);
            PopupManager.Instance.DialogBox.ShowWith1Button(m?.Name ?? marker.ModeId, m == null ? "" : $"{m.Description}\n\n{m.Players} · Free Play · unranked");
            return false;
        }

        // ---- mode name on the versus screen and in the lobby invite --------------------------------------------

        [HarmonyPatch(typeof(VersusReferences), nameof(VersusReferences.SetupContent))]
        [HarmonyPostfix]
        private static void OnVersus(VersusReferences __instance, GameInformation gameInfo)
        {
            try
            {
                string name = ServerList.IsCustomSelected ? GameModes.DisplayName(gameInfo) : null;
                if (name == null || __instance.MapNamePanel == null)
                {
                    return;
                }
                __instance.MapNamePanel.text = $"{__instance.MapNamePanel.text} · {name}";
                Communitan.logger.LogInfo($"GameModes: versus screen map line '{__instance.MapNamePanel.text}'");
                Harness.ShotLater("versus", 2f);
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: versus screen: {e.Message}");
            }
        }

        // Invite dialog: same as the game's (MatchInvitedHandler.ShowInvite) plus the lobby's mode.
        [HarmonyPatch(typeof(MatchInvitedHandler), "ShowInvite")]
        [HarmonyPrefix]
        private static bool OnShowInvite(MatchInvitedHandler __instance)
        {
            try
            {
                Traverse t = Traverse.Create(__instance);
                MultiplayerGameInformation gi = t.Field("gameInfo").GetValue<MultiplayerGameInformation>();
                PlayerDetails inviter = t.Field("inviter").GetValue<PlayerDetails>();
                string id = ServerList.IsCustomSelected ? GameModes.QueuedMode(gi) : null;
                if (id == null || inviter == null)
                {
                    return true;
                }
                ModeInfo m = ModeList.Find(id);
                string header = new UnityGameBase.Core.Globalization.LString("match_challenge_invite_header");
                string invite = new UnityGameBase.Core.Globalization.LString("match_challenge_invite_text_short").Params(inviter.GetNameOrDefault());
                string content = invite + $"\n\nGame mode: <b>{m?.Name ?? id}</b>" + (m == null ? "" : $" ({m.Players})\n{m.Description}");
                Action ok = AccessTools.MethodDelegate<Action>(AccessTools.Method(typeof(MatchInvitedHandler), "OnOkClicked"), __instance);
                Action cancel = AccessTools.MethodDelegate<Action>(AccessTools.Method(typeof(MatchInvitedHandler), "OnCancelClicked"), __instance);
                PopupManager.Instance.DialogBox.ShowWith2Buttons(header, content, ok, cancel);
                CommonNetworking.Instance.Lobby.Inviter = inviter.GetNameOrDefault();
                Communitan.logger.LogInfo($"GameModes: invite to a {id} lobby shown");
                return false;
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"GameModes: invite dialog: {e.Message}");
                return true;
            }
        }

        // ---- harness (tools/mp-smoke.sh --ui, bots.sh): drive the new UI like a player would ---------------------

        // Lobby host: open the scenario screen of the custom lobby (Free match box, else The Game) and click the mode cycler
        // until the mode is selected.
        internal static IEnumerator HarnessPickLobbyMode(string id, Action<bool> done)
        {
            ScreenManagerRework sm = FindObjectOfType<ScreenManagerRework>(true);
            sm.OpenScreenWithName("ExpansionScreen");
            yield return new WaitForSeconds(3f);
            Button open = FindObjectsOfType<BoxButtonWrapper>(false)
                .OrderBy(w => w.name == "Button_Box_FreeCustom" ? 0 : 1)
                .Select(w => w.transform.Find("Button")?.GetComponent<Button>())
                .FirstOrDefault(b => b != null && b.gameObject.activeInHierarchy && Enumerable.Range(0, b.onClick.GetPersistentEventCount()).Any(i => b.onClick.GetPersistentMethodName(i) == "OpenScenarioSelectionScreen")
                    && Traverse.Create(b.GetComponentInParent<BoxButtonWrapper>()).Field("_gamemodeData").GetValue<GamemodeData>()?.expansion == ExpansionsEnum.CatanBaseGame);
            Communitan.logger.LogInfo($"Harness: lobby scenario box {(open == null ? "not found" : Path(open.transform))}");
            open?.onClick.Invoke();
            Toggle toggle = null;
            for (float t0 = Time.realtimeSinceStartup; Time.realtimeSinceStartup - t0 < 20f; )
            {
                yield return new WaitForSeconds(1f);
                toggle = settings != null ? settings.transform.Find(ToggleName)?.GetComponent<Toggle>() : null;
                if (toggle != null && toggle.gameObject.activeInHierarchy)
                {
                    break;
                }
            }
            if (toggle == null || !toggle.gameObject.activeInHierarchy)
            {
                Communitan.logger.LogError($"Harness: lobby mode selector not shown (settings={(settings == null ? "none" : Path(settings.transform))}, modes={ModeList.Modes.Count})");
                done(false);
                yield break;
            }
            MultiplayerGameInformation gi = CommonNetworking.Instance.MatchConnecting.GameInfo;
            for (int i = 0; i <= ModeList.Modes.Count && GameModes.QueuedMode(gi) != id; i++)
            {
                toggle.isOn = !toggle.isOn; // what a click does (Toggle.InternalToggle)
                yield return new WaitForSeconds(0.5f);
            }
            TMP_Text text = toggle.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
            Communitan.logger.LogInfo($"Harness: lobby mode selector '{text?.text}' isOn={toggle.isOn} at {Path(toggle.transform)} pos={((RectTransform)toggle.transform).anchoredPosition} spacing={settings.GetComponent<VerticalLayoutGroup>()?.spacing}; queued={GameModes.QueuedMode(gi)}");
            Harness.Shot("lobby-mode-selector");
            yield return new WaitForSecondsRealtime(1f);
            sm.OpenHomeScreen();
            done(GameModes.QueuedMode(gi) == id);
        }

        // Free Play: online expansion screen, click the mode box's Play button.
        internal static IEnumerator HarnessFreePlayBox(string id, Action<bool> done)
        {
            FindObjectOfType<ConnectionState>(true).SetOnline();
            ScreenManagerRework sm = FindObjectOfType<ScreenManagerRework>(true);
            sm.OpenScreenWithName("ExpansionScreen");
            ModeBox box = null;
            for (float t0 = Time.realtimeSinceStartup; Time.realtimeSinceStartup - t0 < 30f; )
            {
                yield return new WaitForSeconds(1f);
                box = FindObjectsOfType<ModeBox>(false).FirstOrDefault(b => b.ModeId == id);
                if (box != null)
                {
                    break;
                }
            }
            if (box == null)
            {
                GameObject fp = FindObjectsOfType<BoxButtonWrapper>(true).FirstOrDefault(w => w.name == "Freeplay_Box")?.gameObject;
                Communitan.logger.LogError($"Harness: Free Play box for mode {id} not shown (source={(freePlaySource == null ? "none" : Path(freePlaySource.transform))}, modes={ModeList.Modes.Count}, state={FindObjectOfType<ConnectionState>(true)?.LobbyState}, freematch={UnityGameBase.Game.Instance?.Options?.EnableFreematch}, Freeplay_Box self={fp?.activeSelf} hierarchy={fp?.activeInHierarchy})");
                Harness.Shot("freeplay-missing");
                done(false);
                yield break;
            }
            yield return new WaitForSeconds(1f);
            foreach (Transform c in box.transform.parent)
            {
                if (c.gameObject.activeSelf)
                {
                    Communitan.logger.LogInfo($"Harness: expansion box {c.name} pos={((RectTransform)c).anchoredPosition} title='{c.Find("Button/Titel")?.GetComponent<TMP_Text>()?.text}'");
                }
            }
            Harness.Shot("freeplay-mode-box");
            yield return new WaitForSecondsRealtime(1f);
            Button play = box.transform.Find("Btn_QuickStart")?.GetComponent<Button>();
            Communitan.logger.LogInfo($"Harness: clicking {(play == null ? "nothing" : Path(play.transform))}");
            play?.onClick.Invoke();
            done(play != null);
        }

        internal static string Path(Transform t)
        {
            string p = t.name;
            for (Transform x = t.parent; x != null; x = x.parent)
            {
                p = x.name + "/" + p;
            }
            return p;
        }
    }
}
