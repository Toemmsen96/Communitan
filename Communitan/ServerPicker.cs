using GameHub.States;
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityGameBase;
using UnityGameBase.Core.Utils;

namespace Communitan
{
    // Opens the server selection: the native screen (NativeServerScreen, cloned from the game's popups) when possible,
    // else this IMGUI fallback (Minecraft-style list) so the user is never locked out.
    // Startup: shown once the main menu UI exists (ServerList.PickerRequired). F10 / login-screen button reopen it.
    // Never created in -batchmode. While the IMGUI version is open, uGUI input is blocked by disabling the EventSystem.
    public class ServerPicker : MonoBehaviour
    {
        private enum Mode { List, Edit, Direct, ConfirmDelete, Warning }

        private const float BaseHeight = 720f;
        private const string Official = ServerList.OfficialName;
        private readonly List<EventSystem> blocked = new List<EventSystem>();
        private static ServerPicker instance;
        private bool open, startup, onLoginScreen, focusForm, formAdvanced, pendingStartup, nativeFailed;
        private Mode mode;
        private string selected, lastClickRow, formName = "", formAddress = "", formKey = "", formError;
        private float lastClickTime;
        private ServerEntry editing, warnEntry;
        private Action warnProceed;
        private Vector2 scroll;
        private GUIStyle windowStyle, rowStyle, rowSelectedStyle, labelStyle, hintStyle, errorStyle, statusStyle, buttonStyle, fieldStyle, disclaimerStyle;
        private Texture2D dimTexture;

        internal static void Create(GameObject host, bool atStartup)
        {
            instance = host.AddComponent<ServerPicker>();
            instance.pendingStartup = atStartup;
        }

        // Native screen first; on any exception log it and fall back to IMGUI for the rest of the session.
        internal static void Show(bool atStartup)
        {
            if (instance == null)
            {
                return;
            }
            if (!instance.nativeFailed && UiRework.PopupManager.Instance != null)
            {
                try
                {
                    NativeServerScreen.Open(atStartup);
                    return;
                }
                catch (Exception e)
                {
                    instance.nativeFailed = true;
                    Communitan.logger.LogError($"Native server screen failed, using fallback UI: {e}");
                    NativeServerScreen.DestroyAll();
                }
            }
            instance.Open(atStartup);
        }

        private void Open(bool atStartup)
        {
            open = true;
            startup = atStartup;
            mode = Mode.List;
            selected = ServerList.Selected;
            ServerPing.Clear();
            Communitan.logger.LogInfo($"Server picker opened (startup={atStartup})");
        }

        private void Close()
        {
            open = false;
            foreach (EventSystem es in blocked)
            {
                if (es != null)
                {
                    es.enabled = true;
                }
            }
            blocked.Clear();
        }

        private void Update()
        {
            if (pendingStartup && (UiRework.PopupManager.Instance != null || ServerSwitch.MenuDeferred))
            {
                pendingStartup = false;
                Show(true);
            }
            if (Input.GetKeyDown(KeyCode.F10))
            {
                if (open)
                {
                    if (!startup)
                    {
                        Close();
                    }
                }
                else if (NativeServerScreen.IsOpen)
                {
                    NativeServerScreen.CloseIfAllowed();
                }
                else
                {
                    Show(false);
                }
            }
            onLoginScreen = !open && !NativeServerScreen.HasLoginButton && IsLoginScreen();
            if (open)
            {
                EventSystem es = EventSystem.current;
                if (es != null && es.enabled)
                {
                    es.enabled = false;
                    blocked.Add(es);
                }
                Cursor.visible = true;
                Cursor.lockState = CursorLockMode.None;
            }
        }

        private static bool IsLoginScreen()
        {
            GameRoot root = Game.Instance as GameRoot;
            BaseState state = root != null ? root.ScreenStateMachine?.GetActiveState() : null;
            return state != null && state.Name == GameHubMenuStates.Login.ToString();
        }

        private void OnGUI()
        {
            if (!open && !onLoginScreen)
            {
                return;
            }
            InitStyles();
            GUI.depth = -1000;
            float scale = Mathf.Max(1f, Screen.height / BaseHeight);
            GUI.matrix = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, new Vector3(scale, scale, 1f));
            float w = Screen.width / scale, h = Screen.height / scale;
            if (!open)
            {
                if (GUI.Button(new Rect(10, 10, 260, 32), $"Server: {ServerList.Selected}  (F10)", buttonStyle))
                {
                    Open(false);
                }
                return;
            }
            GUI.DrawTexture(new Rect(0, 0, w, h), dimTexture);
            float ww = Mathf.Min(760f, w - 20f), wh = Mathf.Min(500f, h - 20f);
            GUI.ModalWindow(0x43435331, new Rect((w - ww) / 2f, (h - wh) / 2f, ww, wh), DrawWindow, "Communitan", windowStyle);
        }

        private void DrawWindow(int id)
        {
            HandleKeys();
            switch (mode)
            {
                case Mode.List:
                    DrawList();
                    break;
                case Mode.ConfirmDelete:
                    GUILayout.Label($"Delete server '{editing.Name}' ({editing.Address})?", labelStyle);
                    GUILayout.FlexibleSpace();
                    GUILayout.BeginHorizontal();
                    if (GUILayout.Button("Delete", buttonStyle))
                    {
                        Delete(editing);
                    }
                    if (GUILayout.Button("Cancel", buttonStyle))
                    {
                        mode = Mode.List;
                    }
                    GUILayout.EndHorizontal();
                    break;
                case Mode.Warning:
                    GUILayout.Label(ServerActions.WarningTitle, labelStyle);
                    GUILayout.Label(ServerActions.WarningText(warnEntry), labelStyle);
                    GUILayout.FlexibleSpace();
                    GUILayout.BeginHorizontal();
                    if (GUILayout.Button("I understand", buttonStyle))
                    {
                        ServerList.Acknowledge(warnEntry);
                        warnProceed();
                    }
                    if (GUILayout.Button("Cancel", buttonStyle))
                    {
                        mode = Mode.List;
                    }
                    GUILayout.EndHorizontal();
                    break;
                default:
                    DrawForm();
                    break;
            }
        }

        // One-time "Community server" warning before the first join of a custom server.
        private void Confirm(ServerEntry entry, Action proceed)
        {
            if (!ServerActions.NeedsWarning(entry))
            {
                proceed();
                return;
            }
            warnEntry = entry;
            warnProceed = proceed;
            mode = Mode.Warning;
        }

        private void HandleKeys()
        {
            Event e = Event.current;
            if (e.type != EventType.KeyDown)
            {
                return;
            }
            if (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter)
            {
                if (mode == Mode.List)
                {
                    Join(selected);
                }
                else if (mode == Mode.Edit || mode == Mode.Direct)
                {
                    SubmitForm();
                }
                e.Use();
            }
            else if (e.keyCode == KeyCode.Escape)
            {
                if (mode != Mode.List)
                {
                    mode = Mode.List;
                }
                else if (!startup)
                {
                    Close();
                }
                e.Use();
            }
        }

        private void DrawList()
        {
            GUILayout.Label(startup ? "Choose where to play. Double-click a server to join." : "Switching to another server logs you out of the current one.", hintStyle);
            scroll = GUILayout.BeginScrollView(scroll);
            string officialUrl = ServerList.Endpoint(ServerList.GetOfficialConfig(Communitan.officialEnv.Value));
            Row(Official, $"Official servers ({Communitan.officialEnv.Value})", officialUrl, officialUrl, null);
            ServerEntry direct = ServerList.Find(ServerList.DirectName);
            if (direct != null)
            {
                Row(direct.Name, direct.Name + " (not saved)", direct.Address + ServerActions.EncryptionMarker(direct, "#ffa940"), direct.Url, direct.EffectiveStatusKey);
            }
            foreach (ServerEntry entry in ServerList.Servers.ToArray())
            {
                Row(entry.Name, entry.Name, entry.Address + ServerActions.EncryptionMarker(entry, "#ffa940"), entry.Url, entry.EffectiveStatusKey);
            }
            GUILayout.EndScrollView();
            ServerEntry custom = ServerList.Servers.Find(s => string.Equals(s.Name, selected, StringComparison.OrdinalIgnoreCase));
            GUILayout.Space(6);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(startup ? "Join" : "Select", buttonStyle))
            {
                Join(selected);
            }
            if (GUILayout.Button("Add", buttonStyle))
            {
                StartForm(Mode.Edit, null);
            }
            GUI.enabled = custom != null;
            if (GUILayout.Button("Edit", buttonStyle))
            {
                StartForm(Mode.Edit, custom);
            }
            if (GUILayout.Button("Delete", buttonStyle))
            {
                editing = custom;
                mode = Mode.ConfirmDelete;
            }
            GUI.enabled = true;
            if (GUILayout.Button("Direct connect", buttonStyle))
            {
                StartForm(Mode.Direct, null);
            }
            if (GUILayout.Button("Refresh", buttonStyle))
            {
                ServerPing.Clear();
            }
            if (!startup && GUILayout.Button("Cancel", buttonStyle))
            {
                Close();
            }
            GUILayout.EndHorizontal();
            GUILayout.Label($"Current: {ServerList.Selected}  -  F10 reopens this list", hintStyle);
            GUILayout.Label(NativeServerScreen.Disclaimer, disclaimerStyle);
        }

        private void Row(string key, string title, string address, string url, string statusKey)
        {
            ServerPing.Result ping = ServerPing.Get(url, statusKey);
            bool isSelected = string.Equals(selected, key, StringComparison.OrdinalIgnoreCase);
            if (GUILayout.Button($"<b>{title}</b>\n<size=13><color=#b8bcc8>{address}</color></size>", isSelected ? rowSelectedStyle : rowStyle, GUILayout.Height(50)))
            {
                if (lastClickRow == key && Time.realtimeSinceStartup - lastClickTime < 0.4f)
                {
                    Join(key);
                    return;
                }
                selected = key;
                lastClickRow = key;
                lastClickTime = Time.realtimeSinceStartup;
            }
            Rect r = GUILayoutUtility.GetLastRect();
            string counts = ping.Counts == null ? "" : $"\n<size=12><color=#b8bcc8>{ping.Counts}</color></size>";
            GUI.Label(new Rect(r.xMax - 330f, r.y, 318f, r.height), $"<color={ServerActions.StatusColor(ping)}>{ping.Text}</color>{counts}", statusStyle);
        }

        private void Join(string key)
        {
            ServerEntry entry = string.Equals(key, Official, StringComparison.OrdinalIgnoreCase) ? null : ServerList.Find(key);
            Confirm(entry, () =>
            {
                Close();
                ServerActions.Join(key);
            });
        }

        private void Delete(ServerEntry entry)
        {
            ServerActions.Delete(entry);
            selected = ServerList.Selected;
            mode = Mode.List;
        }

        private void StartForm(Mode formMode, ServerEntry entry)
        {
            mode = formMode;
            editing = entry;
            formName = entry?.Name ?? "";
            formAddress = entry?.Address ?? "";
            formKey = entry?.ServerKey ?? "defaultkey";
            formAdvanced = formKey != "defaultkey";
            formError = null;
            focusForm = true;
        }

        private void DrawForm()
        {
            GUILayout.Label(mode == Mode.Direct ? "Direct connect (this session only, not saved)" : editing == null ? "Add server" : "Edit server", labelStyle);
            GUILayout.Space(4);
            if (mode == Mode.Edit)
            {
                GUILayout.Label("Name", hintStyle);
                GUI.SetNextControlName("first");
                formName = GUILayout.TextField(formName, 40, fieldStyle);
            }
            GUILayout.Label("Address", hintStyle);
            if (mode == Mode.Direct)
            {
                GUI.SetNextControlName("first");
            }
            formAddress = GUILayout.TextField(formAddress, 200, fieldStyle);
            GUILayout.Label("host, host:port or http(s)://host:port  (default: http, port 7350)", hintStyle);
            formAdvanced = GUILayout.Toggle(formAdvanced, formAdvanced ? "[-] Advanced" : "[+] Advanced", hintStyle);
            if (formAdvanced)
            {
                GUILayout.Label("Server key", hintStyle);
                formKey = GUILayout.TextField(formKey, 100, fieldStyle);
            }
            if (formError != null)
            {
                GUILayout.Label(formError, errorStyle);
            }
            GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(mode == Mode.Direct ? "Connect" : "Save", buttonStyle))
            {
                SubmitForm();
            }
            if (GUILayout.Button("Cancel", buttonStyle))
            {
                mode = Mode.List;
            }
            GUILayout.EndHorizontal();
            if (focusForm && Event.current.type == EventType.Repaint)
            {
                focusForm = false;
                GUI.FocusControl("first");
            }
        }

        private void SubmitForm()
        {
            if (mode == Mode.Direct)
            {
                if (ServerEntry.TryParseAddress(formAddress, out _, out _, out _, out formError))
                {
                    string address = formAddress, key = formKey;
                    Confirm(ServerActions.DirectEntry(address, key), () =>
                    {
                        Close();
                        ServerActions.JoinDirect(address, key, out _);
                    });
                }
                return;
            }
            if (ServerActions.Save(editing, formName, formAddress, formKey, out formError))
            {
                selected = formName.Trim();
                mode = Mode.List;
            }
        }

        private static Texture2D Solid(Color color)
        {
            Texture2D texture = new Texture2D(1, 1) { hideFlags = HideFlags.HideAndDontSave };
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }

        private static void SetBackground(GUIStyle style, Texture2D normal, Texture2D hover)
        {
            style.normal.background = style.onNormal.background = style.focused.background = style.onFocused.background = normal;
            style.hover.background = style.onHover.background = style.active.background = style.onActive.background = hover;
            style.normal.textColor = style.onNormal.textColor = style.hover.textColor = style.onHover.textColor = style.active.textColor = style.onActive.textColor = style.focused.textColor = Color.white;
        }

        private void InitStyles()
        {
            if (windowStyle != null)
            {
                return;
            }
            dimTexture = Solid(new Color(0f, 0f, 0f, 0.65f));
            windowStyle = new GUIStyle(GUI.skin.window) { fontSize = 18, fontStyle = FontStyle.Bold, padding = new RectOffset(16, 16, 40, 14) };
            SetBackground(windowStyle, Solid(new Color(0.11f, 0.12f, 0.14f, 0.98f)), Solid(new Color(0.11f, 0.12f, 0.14f, 0.98f)));
            rowStyle = new GUIStyle(GUI.skin.button) { alignment = TextAnchor.MiddleLeft, richText = true, fontSize = 16, padding = new RectOffset(12, 12, 6, 6), margin = new RectOffset(0, 4, 2, 2) };
            rowSelectedStyle = new GUIStyle(rowStyle);
            SetBackground(rowStyle, Solid(new Color(1f, 1f, 1f, 0.05f)), Solid(new Color(1f, 1f, 1f, 0.12f)));
            SetBackground(rowSelectedStyle, Solid(new Color(0.24f, 0.44f, 0.78f, 0.75f)), Solid(new Color(0.30f, 0.50f, 0.85f, 0.85f)));
            labelStyle = new GUIStyle(GUI.skin.label) { fontSize = 16, richText = true, wordWrap = true };
            hintStyle = new GUIStyle(labelStyle) { fontSize = 14 };
            hintStyle.normal.textColor = hintStyle.onNormal.textColor = new Color(0.72f, 0.74f, 0.78f);
            disclaimerStyle = new GUIStyle(hintStyle) { fontSize = 11, alignment = TextAnchor.MiddleCenter };
            errorStyle = new GUIStyle(labelStyle) { fontSize = 14 };
            errorStyle.normal.textColor = new Color(1f, 0.48f, 0.48f);
            statusStyle = new GUIStyle(labelStyle) { alignment = TextAnchor.MiddleRight, fontSize = 14, wordWrap = false };
            buttonStyle = new GUIStyle(GUI.skin.button) { fontSize = 15, padding = new RectOffset(10, 10, 7, 7) };
            fieldStyle = new GUIStyle(GUI.skin.textField) { fontSize = 16, padding = new RectOffset(6, 6, 5, 5) };
        }
    }
}
