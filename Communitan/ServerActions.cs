using System;

namespace Communitan
{
    // Picker operations shared by the native server screen and the IMGUI fallback. Callers close their UI first.
    internal static class ServerActions
    {
        internal static void Join(string key)
        {
            if (key == null)
            {
                return;
            }
            ServerEntry direct = string.Equals(key, ServerList.DirectName, StringComparison.OrdinalIgnoreCase) ? ServerList.Find(key) : null;
            Finish(direct != null ? (Action)(() => ServerList.SelectDirect(direct)) : () => ServerList.Select(key));
        }

        // One-off server for this session ("Direct connect"); false + error if the address is invalid.
        internal static bool JoinDirect(string address, string serverKey, out string error)
        {
            if (!ServerEntry.TryParseAddress(address, out string scheme, out string host, out int port, out error))
            {
                return false;
            }
            ServerEntry entry = new ServerEntry { Host = host, Port = port, Scheme = scheme, ServerKey = Key(serverKey) };
            Finish(() => ServerList.SelectDirect(entry));
            return true;
        }

        private static void Finish(Action select)
        {
            ServerSwitch.Apply(select);
            ServerSwitch.ReleaseStartup();
            NativeServerScreen.UpdateLoginButton();
        }

        internal static void Delete(ServerEntry entry)
        {
            bool active = string.Equals(ServerList.Selected, entry.Name, StringComparison.OrdinalIgnoreCase) || string.Equals(ServerList.SavedSelection, entry.Name, StringComparison.OrdinalIgnoreCase);
            Action remove = () =>
            {
                ServerList.Servers.Remove(entry);
                ServerList.Save();
                if (active)
                {
                    ServerList.Select(ServerList.OfficialName);
                }
            };
            if (active)
            {
                ServerSwitch.Apply(remove);
                NativeServerScreen.UpdateLoginButton();
            }
            else
            {
                remove();
            }
        }

        // Adds (editing == null) or updates an entry; editing the active server re-applies it (logs out if the endpoint changed).
        internal static bool Save(ServerEntry editing, string name, string address, string serverKey, out string error)
        {
            if (!ServerEntry.TryParseAddress(address, out string scheme, out string host, out int port, out error))
            {
                return false;
            }
            name = (name ?? "").Trim();
            ServerEntry other = ServerList.Find(name);
            error = name.Length == 0 ? "Enter a name" : ServerList.IsReservedName(name) ? $"'{name}' is a reserved name" : other != null && other != editing ? "A server with this name already exists" : null;
            if (error != null)
            {
                return false;
            }
            ServerEntry target = editing ?? new ServerEntry();
            string oldName = editing?.Name;
            bool active = oldName != null && string.Equals(ServerList.Selected, oldName, StringComparison.OrdinalIgnoreCase);
            string key = Key(serverKey);
            Action save = () =>
            {
                target.Name = name;
                target.Host = host;
                target.Port = port;
                target.Scheme = scheme;
                target.ServerKey = key;
                if (editing == null)
                {
                    ServerList.Servers.Add(target);
                }
                if (oldName != null)
                {
                    ServerList.Renamed(oldName, name);
                }
                ServerList.Save();
            };
            if (active)
            {
                ServerSwitch.Apply(save);
                NativeServerScreen.UpdateLoginButton();
            }
            else
            {
                save();
            }
            return true;
        }

        private static string Key(string serverKey)
        {
            return string.IsNullOrWhiteSpace(serverKey) ? "defaultkey" : serverKey.Trim();
        }

        internal const string WarningTitle = "Community server";

        // One-time warning per custom server (host:port), acknowledged in servers.json.
        internal static bool NeedsWarning(ServerEntry entry)
        {
            return entry != null && !ServerList.IsAcknowledged(entry);
        }

        internal static string WarningText(ServerEntry entry)
        {
            string text = "This server is run by its operator, not by USM, CATAN GmbH or this project. "
                + "The operator can see your email, password, device id, IP address, chats and game data.\n\n"
                + "Never use your official Catan Universe password or any password you use elsewhere. Create a separate account or play as a guest.\n\n"
                + "Progress, items, ratings, leaderboards, friends and guilds do not carry over to or from the official servers or other community servers.";
            if (entry.Unencrypted)
            {
                text += "\n\nThis server is not encrypted (http): anyone on the network path can read your traffic, including your password.";
            }
            return text;
        }

        // Builds the one-off entry a Direct connect would use (for the warning); null if the address is invalid.
        internal static ServerEntry DirectEntry(string address, string serverKey)
        {
            return ServerEntry.TryParseAddress(address, out string scheme, out string host, out int port, out _)
                ? new ServerEntry { Name = ServerList.DirectName, Host = host, Port = port, Scheme = scheme, ServerKey = Key(serverKey) }
                : null;
        }

        // Row suffix for servers that send passwords in plain text.
        internal static string EncryptionMarker(ServerEntry entry, string color)
        {
            return entry != null && entry.Unencrypted ? $"   <color={color}>NOT ENCRYPTED</color>" : "";
        }

        internal static string StatusColor(ServerPing.Result ping)
        {
            return !ping.Done ? "#c8c8c8" : ping.Ok ? "#7ee07e" : "#ff7a7a";
        }
    }
}
