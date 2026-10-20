// MAIL_*, SendFriendMessageRequest. Mail = storage collection "mail" (owner = recipient), per-user counter in "mailmeta". Contract: account-social.md "MAIL_*".

function socMailNextIdx(nk: nkruntime.Nakama, userId: string): number {
    const m = storeGet(nk, "mailmeta", "main", userId) || { last: 0 };
    m.last = (m.last || 0) + 1;
    storePut(nk, "mailmeta", "main", userId, m);
    return m.last;
}

// Stores a mail for `to`; returns the wire doc (GS Mail fields).
function socMailPut(c: GsContext, to: string, fromId: string, who: string, message: string): any {
    const id = c.nk.uuidv4();
    const d = { messageId: id, idx: socMailNextIdx(c.nk, to), fromId: fromId, playerId: to, who: who, message: message, alreadyRead: false };
    storePut(c.nk, "mail", id, to, d);
    return d;
}

function socMailAll(nk: nkruntime.Nakama, userId: string): any[] {
    const out: any[] = [];
    let cur = "";
    do {
        const r = nk.storageList(userId, "mail", 100, cur);
        for (const o of r.objects || []) out.push(o.value);
        cur = r.cursor || "";
    } while (cur);
    return out;
}

const SOCIAL_MAIL_HANDLERS: GsHandlerTable = {
    MAIL_GET_LATEST_MAILS: (c) => {
        const from = Number(c.req.INDEX) || 0;
        const meta = storeGet(c.nk, "mailmeta", "main", c.userId) || { last: 0 };
        // The inbox only lists mails per friend (UiRework/MessageScreen.cs), so server-sent mails would be invisible
        // but still count as unread. Welcome text lives in SERVERNEWS; drop old system mails.
        const all = socMailAll(c.nk, c.userId);
        const sys = all.filter((m) => m.fromId === STORE_SYSTEM_USER);
        if (sys.length) c.nk.storageDelete(sys.map((m) => ({ collection: "mail", key: m.messageId, userId: c.userId })));
        const ms = all.filter((m) => m.fromId !== STORE_SYSTEM_USER && m.idx > from).sort((a, b) => a.idx - b.idx);
        return { lastIndex: meta.last, messages: ms.map((m) => ({ messageId: m.messageId, fromId: m.fromId, playerId: m.playerId, who: m.who, message: m.message, alreadyRead: m.alreadyRead })) };
    },

    MAIL_READ_MAIL: (c) => {
        const id = String(c.req.MESSAGE_ID || "");
        const m = storeGet(c.nk, "mail", id, c.userId);
        if (m && !m.alreadyRead) { m.alreadyRead = true; storePut(c.nk, "mail", id, c.userId, m); }
        return {};
    },

    MAIL_REMOVE_MAIL: (c) => {
        const id = String(c.req.MESSAGE_ID || "");
        if (id && id.indexOf("outgoing_") !== 0) c.nk.storageDelete([{ collection: "mail", key: id, userId: c.userId }]);
        return {};
    },

    SendFriendMessageRequest: (c) => {
        const ids: string[] = c.req.friendIds || [];
        const who = socName(c, c.userId);
        for (const to of ids) {
            if (!to || to === STORE_SYSTEM_USER || !socUserExists(c, to) || socState(c, to, c.userId) === 3) continue;
            const d = socMailPut(c, to, c.userId, who, String(c.req.message || ""));
            gsPush(c.nk, to, { "@class": ".FriendMessage", messageId: d.messageId, fromId: c.userId, playerId: to, who: who, message: d.message, alreadyRead: false, notification: false, title: "", summary: "", subTitle: "" });
        }
        return {};
    },
};

