using System.Collections.Generic;
using Common.Net.MailSystem;
using HarmonyLib;

namespace Communitan
{
    // The inbox only lists mails per friend (UiRework/MessageScreen.cs), so a server-sent mail (nil-UUID sender) can't be
    // opened but still lights the unread badge. Servers now use SERVERNEWS instead; this drops such mails, including ones
    // the client already cached locally from older server versions.
    internal static class MailFilter
    {
        private const string SystemSender = "00000000-0000-0000-0000-000000000000";

        private static int Strip(List<Mail> mails)
        {
            if (mails == null || !ServerList.IsCustomSelected)
            {
                return 0;
            }
            return mails.RemoveAll(m => m != null && m.From == SystemSender);
        }

        [HarmonyPatch(typeof(MailsCollectionComponent), "OnLocalMailsLoaded")]
        [HarmonyPrefix]
        private static void OnLocalMailsLoaded(MailsCollection c)
        {
            int removed = Strip(c?.MailList);
            if (removed > 0)
            {
                Communitan.logger.LogInfo($"MailFilter: dropped {removed} cached server mail(s)");
            }
        }

        [HarmonyPatch(typeof(MailsCollectionComponent), "OnMailsLoaded")]
        [HarmonyPrefix]
        private static void OnMailsLoaded(List<Mail> list)
        {
            Strip(list);
        }
    }
}
