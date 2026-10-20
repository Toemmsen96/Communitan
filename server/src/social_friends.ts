// FRIEND_*, BLACKLIST_*, GET_BLOCKED_AND_FRIEND_IDS, ListGameFriendsRequest, CHAT_GET_PLAYER_ID. Contract: docs/protocol/account-social.md sec 2.
// Friends/blocks = Nakama friend edges (state 0 friend, 1 invite sent, 2 invite received, 3 blocked). Online = Nakama presence (friend.user.online, socket appearOnline).

// Flat PlayerDetails for a batch of users (profile storage; users without profile get defaults), with guildName + `online`.
function socPlayers(c: GsContext, ids: string[], online?: { [id: string]: boolean }): any[] {
    if (!ids.length) return [];
    const rows = c.nk.storageRead(ids.map((id) => ({ collection: "profile", key: "main", userId: id })));
    const byId: { [id: string]: any } = {};
    for (const r of rows) byId[r.userId] = r.value;
    return ids.map((id) => {
        const p = byId[id] || accDefaultProfile({ nk: c.nk, userId: id } as GsContext);
        const d = profileFlat(c, id, p, false);
        d.id = id;
        if (online) d.online = !!online[id];
        return d;
    });
}

function socPlayer(c: GsContext, id: string): any {
    return socPlayers(c, [id])[0];
}

function socName(c: GsContext, id: string): string {
    const p = storeGet(c.nk, "profile", "main", id);
    return p ? p.displayName : "";
}

// All friend edges of a user grouped by state.
function socFriends(c: GsContext, userId: string): { [state: number]: nkruntime.Friend[] } {
    const out: { [state: number]: nkruntime.Friend[] } = { 0: [], 1: [], 2: [], 3: [] };
    for (const f of c.nk.friendsList(userId, 1000).friends || []) (out[f.state || 0] = out[f.state || 0] || []).push(f);
    return out;
}

function socIds(fs: nkruntime.Friend[]): string[] {
    return fs.map((f) => f.user!.userId);
}

function socOnline(fs: nkruntime.Friend[]): { [id: string]: boolean } {
    const o: { [id: string]: boolean } = {};
    for (const f of fs) o[f.user!.userId] = !!f.user!.online;
    return o;
}

// Relation of `other` as seen from `userId`'s list: -1 none, else friend state.
function socState(c: GsContext, userId: string, other: string): number {
    const r = c.nk.usersGetFriendStatus(userId, [other]);
    return r.length ? (r[0].state as number) : -1;
}

function socUserExists(c: GsContext, id: string): boolean {
    try { return c.nk.usersGetId([id]).length > 0; } catch (e) { return false; }
}

function socBlockedList(c: GsContext): any {
    return { blockedPlayers: socPlayers(c, socIds(socFriends(c, c.userId)[3])) };
}

const SOCIAL_FRIEND_HANDLERS: GsHandlerTable = {
    GET_BLOCKED_AND_FRIEND_IDS: (c) => {
        const f = socFriends(c, c.userId);
        return { blocked: socIds(f[3]), friends: socIds(f[0]) };
    },

    ListGameFriendsRequest: (c) => {
        const f = socFriends(c, c.userId);
        const on = socOnline(f[0]);
        const sd = {
            blockListCount: f[3].length, myFriendListCount: f[0].length,
            playersRequestingFriendshipFromMe: socPlayers(c, socIds(f[2])),
            playersIRequestedForFriendship: socPlayers(c, socIds(f[1])),
        };
        return gsRaw({ friends: socPlayers(c, socIds(f[0]), on), scriptData: sd });
    },

    FRIEND_GET_ONLINE: (c) => {
        const st = socFriends(c, c.userId)[0].map((f) => ({ userId: f.user!.userId, online: !!f.user!.online }));
        return gsRaw({ friendOnlineStatus: st, scriptData: { friendOnlineStatus: st } });
    },

    FRIEND_FIND_PLAYER_BY_NAME: (c) => {
        const q = String(c.req.DISPLAYNAME || "").trim().replace(/[\\%_]/g, "\\$&");
        if (!q) return { players: [] };
        const rows = c.nk.sqlQuery(
            "SELECT value->>'userId' AS uid FROM storage WHERE collection = 'names' AND value->>'name' ILIKE $1 ORDER BY length(value->>'name') LIMIT 20", [q + "%"]);
        const ids = rows.map((r: any) => r.uid).filter((id: string) => id && id !== c.userId);
        return { players: socPlayers(c, ids) };
    },

    FRIEND_REQUEST_FRIENDSHIP: (c) => {
        const to = String(c.req.USER_ID || "");
        if (!to || to === c.userId || !socUserExists(c, to)) gsFail({ errorCode: 38 });
        const mine = socState(c, c.userId, to);
        if (mine === 0 || mine === 1 || mine === 3) return {};
        if (socState(c, to, c.userId) === 3) return {}; // they blocked me: silent
        if (socFriends(c, c.userId)[0].length >= 100) return { currplayer_friendlist_full: { curr: 100, max: 100 } };
        c.nk.friendsAdd(c.userId, c.ctx.username || "", [to], [], {});
        gsPushScript(c.nk, to, mine === 2 ? "FRIEND_FRIENDSHIP_ACCEPTED" : "FRIEND_FRIENDSHIP_REQUESTED", socPlayer(c, c.userId));
        return {};
    },

    FRIEND_ACCEPT_FRIENDSHIP: (c) => {
        const to = String(c.req.USER_ID || "");
        if (socState(c, c.userId, to) !== 2) return {};
        c.nk.friendsAdd(c.userId, c.ctx.username || "", [to], [], {});
        gsPushScript(c.nk, to, "FRIEND_FRIENDSHIP_ACCEPTED", socPlayer(c, c.userId));
        return {};
    },

    // Also cancels an own request / unfriends.
    FRIEND_DECLINE_FRIENDSHIP: (c) => {
        const to = String(c.req.USER_ID || "");
        const s = socState(c, c.userId, to);
        if (s < 0 || s === 3) return {};
        c.nk.friendsDelete(c.userId, c.ctx.username || "", [to], []);
        gsPushScript(c.nk, to, "FRIEND_FRIENDSHIP_DECLINED", socPlayer(c, c.userId));
        return {};
    },

    BLACKLIST_GET_BLOCKED_PLAYERS: (c) => socBlockedList(c),

    BLACKLIST_BLOCK_PLAYER: (c) => {
        const id = String(c.req.PLAYER_ID || "");
        if (!id || id === c.userId || !socUserExists(c, id)) gsFail({ errorCode: 38 });
        if (socState(c, c.userId, id) !== 3) {
            const wasLinked = socState(c, c.userId, id) >= 0;
            c.nk.friendsBlock(c.userId, c.ctx.username || "", [id], []);
            if (wasLinked) gsPushScript(c.nk, id, "FRIEND_FRIENDSHIP_DECLINED", socPlayer(c, c.userId));
        }
        return socBlockedList(c);
    },

    BLACKLIST_UNBLOCK_PLAYER: (c) => {
        const id = String(c.req.PLAYER_ID || "");
        if (socState(c, c.userId, id) === 3) c.nk.friendsDelete(c.userId, c.ctx.username || "", [id], []);
        return socBlockedList(c);
    },

    BLACKLIST_REPORT_PLAYER: (c) => {
        c.logger.info("REPORT %s -> %s reason=%s: %s", c.userId, c.req.PLAYER_ID, c.req.REASON, String(c.req.DESCRIPTION || ""));
        return {};
    },

    CHAT_GET_PLAYER_ID: (c) => {
        const name = String(c.req.PLAYER_NAME || "").trim();
        const n = name ? storeGet(c.nk, "names", accNameKey(c.nk, name), STORE_SYSTEM_USER) : null;
        if (!n) return { playerId: "", displayName: "", isOnline: false };
        const u = c.nk.usersGetId([n.userId]);
        return { playerId: n.userId, displayName: n.name, isOnline: u.length > 0 && !!u[0].online };
    },
};
