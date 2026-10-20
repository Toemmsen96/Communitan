using HarmonyLib;
using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UiRework;
using UnityEngine;
using UnityEngine.UI;
using UnityGameBase;

namespace Communitan
{
    // "Server selection" built at runtime from the game's own UI: PopupManager's "Scrollable Popup" (list) and
    // "PopupTextInput" (add/edit dialog) are cloned and re-wired; delete confirmation uses the game's DialogBox.
    // Entry point: a "Server: <name>" button cloned from the login screen's Discord button.
    // Anything missing throws; ServerPicker then falls back to its IMGUI version.
    public class NativeServerScreen : MonoBehaviour
    {
        internal const string Disclaimer = "Unofficial fan project — not affiliated with or endorsed by United Soft Media (USM), CATAN GmbH or the original game. Personal project.";
        private enum EditMode { Edit, Direct }

        private static NativeServerScreen screen;
        private static Button loginButton;
        private static TMP_Text loginButtonLabel;

        private const float Width = 1600f;
        private class RowStatus
        {
            public string Url, StatusKey;
            public bool Selected;
        }

        private readonly Dictionary<TMP_Text, RowStatus> statusLabels = new Dictionary<TMP_Text, RowStatus>();
        private GameObject editRoot, rowTemplate, rowSelectedTemplate, nameLabel, keyLabel, keyField;
        private Transform rows;
        private Button backButton, editButton, deleteButton;
        private TMP_Text editHeader, editError, advancedLabel;
        private TMP_InputField nameInput, addressInput, keyInput;
        private bool startup, advanced;
        private EditMode editMode;
        private ServerEntry editing;
        private string selected, lastClickKey;
        private float lastClickTime, nextStatusUpdate;

        internal static bool IsOpen => screen != null && screen.gameObject.activeSelf;

        internal static bool HasLoginButton => loginButton != null;

        internal static void Open(bool atStartup)
        {
            if (screen == null)
            {
                Build(PopupManager.Instance ?? throw new InvalidOperationException("PopupManager not ready"));
            }
            screen.startup = atStartup;
            screen.selected = ServerList.Selected;
            screen.backButton.gameObject.SetActive(!atStartup);
            screen.editRoot.SetActive(false);
            ServerPing.Clear();
            screen.gameObject.SetActive(true);
            screen.RebuildRows();
            Communitan.logger.LogInfo($"Server selection opened (native, startup={atStartup})");
        }

        internal static void CloseIfAllowed()
        {
            if (screen != null && !screen.startup)
            {
                screen.Close();
            }
        }

        internal static void DestroyAll()
        {
            if (screen != null)
            {
                Destroy(screen.editRoot);
                Destroy(screen.gameObject);
            }
            screen = null;
        }

        internal static void UpdateLoginButton()
        {
            if (loginButtonLabel != null)
            {
                loginButtonLabel.text = $"Server: {ServerList.Selected}";
            }
        }

        private void Close()
        {
            editRoot.SetActive(false);
            gameObject.SetActive(false);
        }

        // ---- building ------------------------------------------------------------------------------------

        private static void Build(PopupManager pm)
        {
            GameObject listTemplate = pm.scrollableDialogBox?.gameObject ?? throw new InvalidOperationException("no Scrollable Popup");
            GameObject root = Clone(listTemplate, listTemplate.transform.parent);
            root.name = "Communitan_ServerSelection";
            DestroyImmediate(root.GetComponent<PopupDialogBox>());
            screen = root.AddComponent<NativeServerScreen>();
            try
            {
                screen.BuildList(root.transform);
                screen.BuildEdit(pm.TextInputPopup?.gameObject ?? throw new InvalidOperationException("no PopupTextInput"));
            }
            catch
            {
                DestroyAll();
                throw;
            }
            // Below the game's own DialogBox (used for the delete confirmation).
            root.transform.SetSiblingIndex(0);
            screen.editRoot.transform.SetSiblingIndex(1);
            RectTransform listRect = (RectTransform)root.transform, editRect = (RectTransform)screen.editRoot.transform;
            editRect.offsetMin = listRect.offsetMin;
            editRect.offsetMax = listRect.offsetMax;
        }

        private void BuildList(Transform root)
        {
            Transform popup = Req(root, "Popup");
            TMP_Text header = Req<TMP_Text>(popup, "Header");
            header.text = "Server selection";
            Transform scroll = Req(popup, "Scroll View");
            RectTransform popupRect = (RectTransform)popup;
            popupRect.sizeDelta = new Vector2(popupRect.sizeDelta.x + Width - ((RectTransform)scroll).sizeDelta.x, popupRect.sizeDelta.y);
            SetWidth(scroll, Width);
            rows = Req(scroll, "Viewport/Content");
            foreach (Transform child in rows.Cast<Transform>().ToList())
            {
                DestroyImmediate(child.gameObject);
            }
            VerticalLayoutGroup list = rows.GetComponent<VerticalLayoutGroup>();
            list.childControlWidth = list.childForceExpandWidth = list.childControlHeight = true;
            list.childForceExpandHeight = false;
            list.spacing = 14f;
            Transform buttonList = Req(popup, "ButtonList");
            Button negative = Req<Button>(buttonList, "Btn_Negative");
            Button positive = Req<Button>(buttonList, "Btn_Positive");
            GameObject templates = new GameObject("Templates");
            templates.SetActive(false);
            templates.transform.SetParent(root, false);
            rowTemplate = MakeRowTemplate(negative, templates.transform);
            rowSelectedTemplate = MakeRowTemplate(positive, templates.transform);

            Transform actions = Clone(buttonList.gameObject, popup).transform;
            actions.name = "ActionList";
            actions.SetSiblingIndex(buttonList.GetSiblingIndex());
            foreach (Transform child in actions.Cast<Transform>().ToList())
            {
                DestroyImmediate(child.gameObject);
            }
            HorizontalLayoutGroup actionLayout = actions.GetComponent<HorizontalLayoutGroup>();
            actionLayout.childControlWidth = actionLayout.childForceExpandWidth = true;
            actionLayout.spacing = 16f;
            CloneButton(negative, actions, Loc("friends_add", "Add"), () => OpenEdit(EditMode.Edit, null));
            editButton = CloneButton(negative, actions, Loc("guild_edit_guild", "Edit"), () => OpenEdit(EditMode.Edit, SelectedCustom()));
            deleteButton = CloneButton(negative, actions, Loc("common_remove", "Remove"), ConfirmDelete);
            CloneButton(negative, actions, "Direct", () => OpenEdit(EditMode.Direct, null));
            CloneButton(negative, actions, "Refresh", () => { ServerPing.Clear(); RebuildRows(); });
            SetWidth(actions, Width);
            foreach (TMP_Text label in actions.GetComponentsInChildren<TMP_Text>(true))
            {
                label.enableAutoSizing = false;
                label.fontSize = label.fontSizeMax * 0.75f;
            }

            backButton = Rewire(negative, Loc("common_back_button", "Back"), Close);
            Rewire(positive, Loc("tournament_btn_join_tournament", "Join"), () => Join(selected));

            TMP_Text disclaimer = Clone(header.gameObject, popup).GetComponent<TMP_Text>();
            disclaimer.name = "Disclaimer";
            disclaimer.enableAutoSizing = false;
            disclaimer.fontSize = Mathf.Max(18f, header.fontSize * 0.42f);
            disclaimer.fontStyle = FontStyles.Normal;
            disclaimer.enableWordWrapping = true;
            disclaimer.alignment = TextAlignmentOptions.Center;
            disclaimer.color = new Color(0.78f, 0.74f, 0.66f, 0.85f);
            disclaimer.text = Disclaimer;
            SetWidth(disclaimer.transform, Width);
        }

        private void BuildEdit(GameObject template)
        {
            editRoot = Clone(template, template.transform.parent);
            editRoot.name = "Communitan_ServerEdit";
            DestroyImmediate(editRoot.GetComponent<TextInputPopup>());
            Transform popup = Req(editRoot.transform, "Popup");
            editHeader = Req<TMP_Text>(popup, "Lb_Header");
            TMP_Text label = Req<TMP_Text>(popup, "Lb_Description");
            nameInput = Req<TMP_InputField>(popup, "Input_New Name");
            int index = label.transform.GetSiblingIndex();
            addressInput = CloneInput(nameInput, popup, "host, host:port or https://host:port");
            keyInput = CloneInput(nameInput, popup, "defaultkey");
            SetPlaceholder(nameInput, "Name ...");
            TMP_Text addressLabel = CloneLabel(label, popup, "Address");
            TMP_Text hint = CloneLabel(label, popup, "Default: http, port 7350");
            hint.fontSize *= 0.8f;
            hint.color = new Color(hint.color.r, hint.color.g, hint.color.b, 0.7f);
            advancedLabel = CloneLabel(label, popup, "");
            Button advancedButton = advancedLabel.gameObject.AddComponent<Button>();
            advancedButton.targetGraphic = advancedLabel;
            advancedButton.onClick.AddListener(() => SetAdvanced(!advanced));
            TMP_Text keyText = CloneLabel(label, popup, "Server key");
            editError = CloneLabel(label, popup, "");
            editError.color = new Color(1f, 0.45f, 0.4f);
            label.text = Loc("tournament_name", "Name");
            nameLabel = label.gameObject;
            keyLabel = keyText.gameObject;
            keyField = keyInput.gameObject;
            Component[] order = { label, nameInput, addressLabel, addressInput, hint, advancedLabel, keyText, keyInput, editError };
            for (int i = 0; i < order.Length; i++)
            {
                order[i].transform.SetSiblingIndex(index + i);
            }
            Transform buttons = Req(popup, "ButtonList");
            Rewire(Req<Button>(buttons, "Btn_Cancel"), Loc("quickmatch_cancel_button", "Cancel"), () => editRoot.SetActive(false));
            Rewire(Req<Button>(buttons, "Btn_OK"), Loc("common_ok_button", "OK"), Submit);
            foreach (TMP_InputField input in new[] { nameInput, addressInput, keyInput })
            {
                input.onSubmit = new TMP_InputField.SubmitEvent();
                input.onSubmit.AddListener(_ => Submit());
            }
        }

        private static GameObject MakeRowTemplate(Button source, Transform parent)
        {
            GameObject row = Clone(source.gameObject, parent);
            row.name = "Row";
            LayoutElement layout = row.GetComponent<LayoutElement>() ?? row.AddComponent<LayoutElement>();
            layout.minHeight = layout.preferredHeight = 130f;
            layout.flexibleWidth = 1f;
            TMP_Text title = row.GetComponentInChildren<TMP_Text>(true);
            title.name = "Title";
            title.enableAutoSizing = false;
            title.fontStyle &= ~FontStyles.UpperCase;
            title.richText = true;
            title.enableWordWrapping = false;
            title.overflowMode = TextOverflowModes.Ellipsis;
            title.alignment = TextAlignmentOptions.MidlineLeft;
            Stretch(title.rectTransform, 0f, 1f, 50f, -600f);
            TMP_Text status = Instantiate(title.gameObject, row.transform, false).GetComponent<TMP_Text>();
            status.name = "Status";
            status.alignment = TextAlignmentOptions.MidlineRight;
            status.fontSize = title.fontSize * 0.8f;
            Stretch(status.rectTransform, 1f, 1f, -580f, -50f);
            return row;
        }

        // ---- list ----------------------------------------------------------------------------------------

        private void RebuildRows()
        {
            statusLabels.Clear();
            foreach (Transform child in rows)
            {
                child.gameObject.SetActive(false);
                Destroy(child.gameObject);
            }
            string officialUrl = ServerList.Endpoint(ServerList.GetOfficialConfig(Communitan.officialEnv.Value));
            AddRow(ServerList.OfficialName, $"Official servers ({Communitan.officialEnv.Value})", officialUrl, officialUrl, null);
            ServerEntry direct = ServerList.Find(ServerList.DirectName);
            if (direct != null)
            {
                AddRow(direct.Name, direct.Name + " (not saved)", direct.Address, direct.Url, direct);
            }
            foreach (ServerEntry entry in ServerList.Servers)
            {
                AddRow(entry.Name, entry.Name, entry.Address, entry.Url, entry);
            }
            bool custom = SelectedCustom() != null;
            editButton.interactable = deleteButton.interactable = custom;
            UpdateStatus();
        }

        private void AddRow(string key, string title, string address, string url, ServerEntry entry)
        {
            bool isSelected = string.Equals(selected, key, StringComparison.OrdinalIgnoreCase);
            address += ServerActions.EncryptionMarker(entry, isSelected ? "#9a3b00" : "#ffa940");
            GameObject row = Instantiate(isSelected ? rowSelectedTemplate : rowTemplate, rows, false);
            row.SetActive(true);
            row.transform.Find("Title").GetComponent<TMP_Text>().text = $"{title}\n<size=70%>{address}</size>";
            statusLabels[row.transform.Find("Status").GetComponent<TMP_Text>()] = new RowStatus { Url = url, StatusKey = entry?.EffectiveStatusKey, Selected = isSelected };
            row.GetComponent<Button>().onClick.AddListener(() => OnRowClicked(key));
        }

        private void OnRowClicked(string key)
        {
            if (lastClickKey == key && Time.unscaledTime - lastClickTime < 0.4f)
            {
                Join(key);
                return;
            }
            lastClickKey = key;
            lastClickTime = Time.unscaledTime;
            selected = key;
            RebuildRows();
        }

        private void Update()
        {
            if (!editRoot.activeSelf && !PopupManager.Instance.DialogBox.gameObject.activeSelf)
            {
                if (Input.GetKeyDown(KeyCode.Return) || Input.GetKeyDown(KeyCode.KeypadEnter))
                {
                    Join(selected);
                    return;
                }
                if (Input.GetKeyDown(KeyCode.Escape) && !startup)
                {
                    Close();
                    return;
                }
            }
            if (Time.unscaledTime >= nextStatusUpdate)
            {
                UpdateStatus();
            }
        }

        private void UpdateStatus()
        {
            nextStatusUpdate = Time.unscaledTime + 0.25f;
            foreach (KeyValuePair<TMP_Text, RowStatus> pair in statusLabels)
            {
                // Official: ping only; custom servers: + public player counts (servers without COMMUNITAN_STATUS: ping only).
                ServerPing.Result ping = ServerPing.Get(pair.Value.Url, pair.Value.StatusKey);
                if (pair.Key != null)
                {
                    // Darker colors on the yellow (selected) row.
                    bool sel = pair.Value.Selected;
                    string color = !sel ? ServerActions.StatusColor(ping) : !ping.Done ? "#5a4a28" : ping.Ok ? "#1e6b2a" : "#a31d1d";
                    string counts = ping.Counts == null ? "" : $"\n<size=70%><color={(sel ? "#3d2f12" : "#d8d2c4")}>{ping.Counts}</color></size>";
                    pair.Key.text = $"<color={color}>{ping.Text}</color>{counts}";
                }
            }
        }

        private ServerEntry SelectedCustom()
        {
            return ServerList.Servers.Find(s => string.Equals(s.Name, selected, StringComparison.OrdinalIgnoreCase));
        }

        private void Join(string key)
        {
            ServerEntry entry = string.Equals(key, ServerList.OfficialName, StringComparison.OrdinalIgnoreCase) ? null : ServerList.Find(key);
            Confirm(entry, () =>
            {
                Close();
                ServerActions.Join(key);
            });
        }

        // Shows the one-time "Community server" warning (game dialog) before proceeding, if not acknowledged yet.
        private static void Confirm(ServerEntry entry, Action proceed)
        {
            if (!ServerActions.NeedsWarning(entry))
            {
                proceed();
                return;
            }
            PopupManager.Instance.DialogBox.ShowWith2Buttons(ServerActions.WarningTitle, ServerActions.WarningText(entry), () =>
            {
                ServerList.Acknowledge(entry);
                proceed();
            }, null, "I understand", Loc("quickmatch_cancel_button", "Cancel"));
        }

        private void ConfirmDelete()
        {
            ServerEntry entry = SelectedCustom();
            if (entry == null)
            {
                return;
            }
            PopupManager.Instance.DialogBox.ShowWith2Buttons("Remove server", $"Remove '{entry.Name}' ({entry.Address}) from the list?", () =>
            {
                ServerActions.Delete(entry);
                selected = ServerList.Selected;
                RebuildRows();
            }, null, Loc("common_remove", "Remove"), Loc("quickmatch_cancel_button", "Cancel"));
        }

        // ---- add / edit / direct -------------------------------------------------------------------------

        private void OpenEdit(EditMode mode, ServerEntry entry)
        {
            editMode = mode;
            editing = entry;
            editHeader.text = mode == EditMode.Direct ? "Direct connect" : entry == null ? "Add server" : "Edit server";
            editError.text = mode == EditMode.Direct ? "Connects once, not saved to the list." : "";
            editError.color = mode == EditMode.Direct ? new Color(0.85f, 0.82f, 0.75f) : new Color(1f, 0.45f, 0.4f);
            editRoot.SetActive(true);
            nameLabel.SetActive(mode == EditMode.Edit);
            nameInput.gameObject.SetActive(mode == EditMode.Edit);
            nameInput.text = entry?.Name ?? "";
            addressInput.text = entry?.Address ?? "";
            keyInput.text = entry?.ServerKey ?? "defaultkey";
            SetAdvanced(keyInput.text != "defaultkey");
            (mode == EditMode.Edit ? nameInput : addressInput).ActivateInputField();
        }

        private void SetAdvanced(bool value)
        {
            advanced = value;
            advancedLabel.text = value ? "- Advanced" : "+ Advanced";
            keyLabel.SetActive(value);
            keyField.SetActive(value);
        }

        private void Submit()
        {
            if (!editRoot.activeSelf)
            {
                return;
            }
            string error;
            if (editMode == EditMode.Direct)
            {
                string address = addressInput.text, key = keyInput.text;
                if (ServerEntry.TryParseAddress(address, out _, out _, out _, out error))
                {
                    Confirm(ServerActions.DirectEntry(address, key), () =>
                    {
                        Close();
                        ServerActions.JoinDirect(address, key, out _);
                    });
                    return;
                }
            }
            else if (ServerActions.Save(editing, nameInput.text, addressInput.text, keyInput.text, out error))
            {
                selected = nameInput.text.Trim();
                editRoot.SetActive(false);
                RebuildRows();
                return;
            }
            editError.color = new Color(1f, 0.45f, 0.4f);
            editError.text = error;
        }

        // ---- login screen entry point --------------------------------------------------------------------

        [HarmonyPatch(typeof(LoginScreenRework), "Show")]
        [HarmonyPostfix]
        private static void AddLoginButton(LoginScreenRework __instance)
        {
            try
            {
                if (loginButton == null)
                {
                    Button discord = __instance.GetComponentsInChildren<Button>(true).FirstOrDefault(b => b.name == "Discord_Button") ?? throw new InvalidOperationException("Discord_Button not found");
                    loginButton = CloneButton(discord, discord.transform.parent, "", () => ServerPicker.Show(false));
                    loginButton.name = "Server_Button";
                    loginButton.transform.SetSiblingIndex(discord.transform.GetSiblingIndex());
                    loginButtonLabel = loginButton.GetComponentInChildren<TMP_Text>(true);
                    loginButtonLabel.enableAutoSizing = true;
                    loginButtonLabel.fontSizeMin = loginButtonLabel.fontSize * 0.5f;
                    loginButtonLabel.fontSizeMax = loginButtonLabel.fontSize;
                }
                UpdateLoginButton();
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Cannot add the server button to the login screen (F10 still works): {e.Message}");
            }
        }

        // ---- helpers -------------------------------------------------------------------------------------

        private static string Loc(string key, string fallback)
        {
            string text = Game.Instance != null && Game.Instance.gameLoca != null ? Game.Instance.gameLoca.GetText(key) : null;
            return string.IsNullOrEmpty(text) || text.StartsWith("KNF:") || text == "Empty Key!" || text.Contains("<color=red>") ? fallback : text;
        }

        // Instantiates a template and strips the game's localizers so our texts stay.
        private static GameObject Clone(GameObject template, Transform parent)
        {
            GameObject clone = Instantiate(template, parent, false);
            foreach (TMP_Localization localization in clone.GetComponentsInChildren<TMP_Localization>(true))
            {
                DestroyImmediate(localization);
            }
            return clone;
        }

        private static Button CloneButton(Button template, Transform parent, string text, Action onClick)
        {
            GameObject clone = Clone(template.gameObject, parent);
            foreach (OpenURL url in clone.GetComponentsInChildren<OpenURL>(true))
            {
                DestroyImmediate(url);
            }
            clone.SetActive(true);
            return Rewire(clone.GetComponent<Button>(), text, onClick);
        }

        private static Button Rewire(Button button, string text, Action onClick)
        {
            button.onClick = new Button.ButtonClickedEvent();
            button.onClick.AddListener(() => onClick());
            button.interactable = true;
            TMP_Text label = button.GetComponentInChildren<TMP_Text>(true);
            if (label != null)
            {
                label.text = text;
            }
            return button;
        }

        private static TMP_Text CloneLabel(TMP_Text template, Transform parent, string text)
        {
            TMP_Text label = Clone(template.gameObject, parent).GetComponent<TMP_Text>();
            label.text = text;
            return label;
        }

        private static TMP_InputField CloneInput(TMP_InputField template, Transform parent, string placeholder)
        {
            TMP_InputField input = Clone(template.gameObject, parent).GetComponent<TMP_InputField>();
            SetPlaceholder(input, placeholder);
            return input;
        }

        private static void SetPlaceholder(TMP_InputField input, string text)
        {
            if (input.placeholder is TMP_Text placeholder)
            {
                placeholder.text = text;
            }
        }

        private static void SetWidth(Transform target, float width)
        {
            RectTransform rect = (RectTransform)target;
            rect.sizeDelta = new Vector2(width, rect.sizeDelta.y);
            LayoutElement layout = target.GetComponent<LayoutElement>() ?? target.gameObject.AddComponent<LayoutElement>();
            layout.preferredWidth = layout.minWidth = width;
        }

        private static void Stretch(RectTransform rect, float anchorMinX, float anchorMaxX, float left, float right)
        {
            rect.anchorMin = new Vector2(anchorMinX == 1f ? 1f : 0f, 0f);
            rect.anchorMax = new Vector2(anchorMaxX, 1f);
            rect.offsetMin = new Vector2(left, 0f);
            rect.offsetMax = new Vector2(right, 0f);
        }

        private static Transform Req(Transform root, string path)
        {
            return root.Find(path) ?? throw new InvalidOperationException($"UI element '{path}' not found under {root.name}");
        }

        private static T Req<T>(Transform root, string path) where T : Component
        {
            return Req(root, path).GetComponent<T>() ?? throw new InvalidOperationException($"'{path}' has no {typeof(T).Name}");
        }
    }
}
