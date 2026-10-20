// GUILD_* + guild/whisper chat. Contract: docs/protocol/account-social.md sec 2 (GUILD_*, CHAT_SEND_TO_PLAYER_ID, SendTeamChatMessageRequest).
// Guild = Nakama group (closed). Roles: superadmin(0)=owner, admin(1), member(2), join request(3)=aspirant. MOTD + elo in group metadata.

const SOC_GUILD_PAGE = 20;

interface SocGuild { group: nkruntime.Group; state: number }

function socMyGuild(nk: nkruntime.Nakama, userId: string): SocGuild | null {
    for (const g of nk.userGroupsList(userId, 100).userGroups || []) {
        if ((g.state as number) <= 2) return { group: g.group!, state: g.state as number };
    }
    return null;
}

function socAspirantGuildId(nk: nkruntime.Nakama, userId: string): string {
    for (const g of nk.userGroupsList(userId, 100).userGroups || []) if (g.state === 3) return g.group!.id;
    return "";
}

// Used by account.ts profileFlat.
function socGuildName(nk: nkruntime.Nakama, userId: string): string {
    const g = socMyGuild(nk, userId);
    return g ? g.group.name : "";
}

function socGuildMembers(nk: nkruntime.Nakama, gid: string): { uid: string; state: number }[] {
    return (nk.groupUsersList(gid, 100).groupUsers || []).map((u) => ({ uid: u.user.userId, state: u.state as number }));
}

// Guild object (Common.Net/Guild.cs). detail=true adds members/aspirants/owner profiles.
function socGuildObj(c: GsContext, g: nkruntime.Group, detail: boolean): any {
    const us = socGuildMembers(c.nk, g.id);
    const mem = us.filter((u) => u.state <= 2).map((u) => u.uid);
    const asp = us.filter((u) => u.state === 3).map((u) => u.uid);
    const owner = us.filter((u) => u.state === 0).map((u) => u.uid)[0] || g.creatorId;
    const md = g.metadata || {};
    const o: any = {
        guildId: g.id, guildName: g.name, guildDescription: g.description || "", guildMessageOfTheDay: md.motd || "",
        ownerId: owner, ownerName: socName(c, owner), elo: md.elo !== undefined ? md.elo : 1000.0, memberIds: mem, aspirantIds: asp,
    };
    if (detail) {
        o.members = socPlayers(c, mem);
        o.aspirants = socPlayers(c, asp);
        o.owner = socPlayer(c, owner);
    }
    return o;
}

function socGuildPush(c: GsContext, uids: string[], extCode: string, data: any) {
    for (const u of uids) if (u !== c.userId) gsPushScript(c.nk, u, extCode, data);
}

function socGuildErr(error: any): any {
    return gsRaw({ scriptData: { guildData: { error: error } } });
}

// Caller's guild, requiring admin rights (state <= 1).
function socAdminGuild(c: GsContext): SocGuild {
    const g = socMyGuild(c.nk, c.userId);
    if (!g) gsFail({ errorCode: 32 });
    if (g!.state > 1) gsFail({ errorCode: 31 });
    return g!;
}

function socGuildPage(c: GsContext, gs: nkruntime.Group[]): any {
    const skip = Number(c.req.SKIP) || 0;
    return { guilds: gs.slice(skip, skip + SOC_GUILD_PAGE).map((g) => socGuildObj(c, g, false)) };
}

// Deletes a guild + its GUILD_ELO_RANKING record, pushes GUILD_CLOSED to everyone else in it.
function socGuildDisband(c: GsContext, g: nkruntime.Group) {
    const us = socGuildMembers(c.nk, g.id);
    c.nk.groupDelete(g.id);
    try { c.nk.leaderboardRecordDelete(RK_LB_GUILD, g.id); } catch (e) { /* no record */ }
    socGuildPush(c, us.map((u) => u.uid), "GUILD_CLOSED", {});
}

// Account deletion: drop c.userId from its guild like GUILD_LEAVE. An owner hands the guild to the
// highest-ranked remaining member (admin before member, Nakama join order), or disbands it when alone.
function socGuildRemoveUser(c: GsContext) {
    for (const ug of c.nk.userGroupsList(c.userId, 100).userGroups || []) {
        const g = ug.group!;
        if (ug.state === 0) {
            const heirs = socGuildMembers(c.nk, g.id).filter((u) => u.uid !== c.userId && u.state <= 2).sort((a, b) => a.state - b.state);
            if (!heirs.length) { socGuildDisband(c, g); continue; }
            const h = heirs[0];
            for (let s = h.state; s > 0; s--) c.nk.groupUsersPromote(g.id, [h.uid]); // member -> admin -> superadmin
        }
        c.nk.groupUserLeave(g.id, c.userId, c.ctx.username || "");
        if ((ug.state as number) <= 2) {
            const o = socGuildObj(c, g, false);
            socGuildPush(c, o.memberIds, "GUILD_REMOVED_PLAYER", o);
        }
    }
}

const SOCIAL_GUILD_HANDLERS: GsHandlerTable = {
    GUILD_GET_DETAILS: (c) => {
        const g = socMyGuild(c.nk, c.userId);
        return g ? { guildData: socGuildObj(c, g.group, true) } : {};
    },

    GUILD_GET_DETAILS_BY_ID: (c) => {
        const g = c.nk.groupsGetId([String(c.req.GUILD_ID || "")]);
        if (!g.length) gsFail({ errorCode: 32 });
        return { guildData: socGuildObj(c, g[0], true) };
    },

    GUILD_GET_GUILD_DETAILS_FOR_PLAYER: (c) => {
        const g = socMyGuild(c.nk, String(c.req.PLAYER_ID || ""));
        return g ? { guildData: socGuildObj(c, g.group, false) } : {};
    },

    GUILD_CREATE: (c) => {
        const name = String(c.req.GUILD_NAME || "").trim();
        if (name.length < 3) return { invalid_guild_name: true };
        if (name.length > 30) gsFail({ errorCode: 26 });
        if (socMyGuild(c.nk, c.userId)) return socGuildErr("Already guild member");
        let g: nkruntime.Group;
        try {
            g = c.nk.groupCreate(c.userId, name, c.userId, "en", String(c.req.GUILD_DESCRIPTION || ""), null, false,
                { motd: String(c.req.GUILD_MESSAGE_OF_THE_DAY || ""), elo: 1000.0 }, 100);
        } catch (e) {
            const dup = c.nk.groupsList(name, undefined, undefined, undefined, 1).groups || [];
            if (dup.length && dup[0].name.toLowerCase() === name.toLowerCase()) return socGuildErr("GUILD_ALREADY_EXISTS");
            throw e;
        }
        return { guildData: socGuildObj(c, g, true) };
    },

    GUILD_SET_DESCRIPTION: (c) => {
        const g = socAdminGuild(c).group;
        const md = g.metadata || {};
        md.motd = String(c.req.MESSAGE_OF_THE_DAY || "");
        c.nk.groupUpdate(g.id, null, null, null, null, String(c.req.DESCRIPTION || ""), null, null, md);
        socGuildPush(c, socGuildMembers(c.nk, g.id).filter((u) => u.state <= 2).map((u) => u.uid), "GUILD_GMOTD_UPDATE", { message: md.motd });
        return {};
    },

    GUILD_JOIN_REQUEST: (c) => {
        const gid = String(c.req.GUILD_ID || "");
        const gs = c.nk.groupsGetId([gid]);
        if (!gs.length) gsFail({ errorCode: 32 });
        if (socMyGuild(c.nk, c.userId)) gsFail({ errorCode: 19 });
        const us = socGuildMembers(c.nk, gid);
        if (us.filter((u) => u.state <= 2).length >= gs[0].maxCount) gsFail({ errorCode: 47 });
        c.nk.groupUserJoin(gid, c.userId, c.ctx.username || "");
        const o = socGuildObj(c, gs[0], false);
        socGuildPush(c, us.filter((u) => u.state <= 1).map((u) => u.uid), "GUILD_NEW_REQUEST", o);
        return {};
    },

    GUILD_ACCEPT_ASPIRANT: (c) => {
        const g = socAdminGuild(c).group;
        const pid = String(c.req.PLAYER_ID || "");
        const us = socGuildMembers(c.nk, g.id);
        if (!us.some((u) => u.uid === pid && u.state === 3)) gsFail({ errorCode: 38 });
        if (us.filter((u) => u.state <= 2).length >= g.maxCount) gsFail({ errorCode: 47 });
        c.nk.groupUsersAdd(g.id, [pid], c.userId);
        const o = socGuildObj(c, g, true);
        gsPushScript(c.nk, pid, "GUILD_REQUEST_ACCEPTED", socGuildObj(c, g, false));
        return { guildData: o };
    },

    GUILD_DECLINE_ASPIRANT: (c) => {
        const g = socAdminGuild(c).group;
        const pid = String(c.req.PLAYER_ID || "");
        c.nk.groupUsersKick(g.id, [pid], c.userId);
        gsPushScript(c.nk, pid, "GUILD_REQUEST_NOT_ACCEPTED", socGuildObj(c, g, false));
        return { guildData: socGuildObj(c, g, true) };
    },

    GUILD_KICK_PLAYER: (c) => {
        const mine = socAdminGuild(c);
        const g = mine.group;
        const pid = String(c.req.PLAYER_ID || "");
        const us = socGuildMembers(c.nk, g.id);
        const t = us.filter((u) => u.uid === pid)[0];
        if (!t || t.state === 0 || (t.state <= mine.state && mine.state !== 0)) gsFail({ errorCode: 31 });
        c.nk.groupUsersKick(g.id, [pid], c.userId);
        const o = socGuildObj(c, g, false);
        gsPushScript(c.nk, pid, "GUILD_GOT_KICKED", o);
        socGuildPush(c, us.filter((u) => u.state <= 2 && u.uid !== pid).map((u) => u.uid), "GUILD_REMOVED_PLAYER", o);
        return { guildData: socGuildObj(c, g, true) };
    },

    GUILD_LEAVE: (c) => {
        const mine = socMyGuild(c.nk, c.userId);
        if (!mine) return {};
        if (mine.state === 0) gsFail({ errorCode: 20 });
        c.nk.groupUserLeave(mine.group.id, c.userId, c.ctx.username || "");
        const o = socGuildObj(c, mine.group, false);
        socGuildPush(c, o.memberIds, "GUILD_REMOVED_PLAYER", o);
        return {};
    },

    GUILD_CLOSE: (c) => {
        const mine = socMyGuild(c.nk, c.userId);
        if (!mine) return {};
        if (mine.state !== 0) gsFail({ errorCode: 31 });
        socGuildDisband(c, mine.group);
        return {};
    },

    GUILD_FIND_BY_NAME: (c) => {
        const q = String(c.req.GUILDNAME || "").trim();
        const gs = c.nk.groupsList(q ? q + "%" : undefined, undefined, undefined, undefined, 100).groups || [];
        return socGuildPage(c, gs);
    },

    GUILD_GET_MEMBER_SORTED_LIST: (c) => {
        const gs = socAllGroups(c).sort((a, b) => b.edgeCount - a.edgeCount);
        return socGuildPage(c, gs);
    },

    GUILD_GET_ELO_SORTED_LIST: (c) => {
        const gs = socAllGroups(c).sort((a, b) => ((b.metadata || {}).elo || 0) - ((a.metadata || {}).elo || 0));
        return socGuildPage(c, gs);
    },

    // PLAYER_CHAT: recipient gets teamId=sender, sender gets an echo (teamId=recipient); client inserts messages only via this push.
    CHAT_SEND_TO_PLAYER_ID: (c) => {
        const to = String(c.req.PLAYER_ID || "");
        const msg = String(c.req.MESSAGE || "");
        if (!msg || !socUserExists(c, to)) return {};
        const who = socName(c, c.userId);
        const mk = (team: string) => ({ "@class": ".TeamChatMessage", chatMessageId: c.nk.uuidv4(), fromId: c.userId, who: who, message: msg, teamId: team, teamType: "PLAYER_CHAT", ownerId: c.userId });
        if (socState(c, to, c.userId) !== 3) gsPush(c.nk, to, mk(c.userId));
        gsPush(c.nk, c.userId, mk(to), false);
        return {};
    },

    SendTeamChatMessageRequest: (c) => {
        if (c.req.teamType !== "GUILD") return {};
        const g = socMyGuild(c.nk, c.userId);
        const msg = String(c.req.message || "");
        if (!g || !msg) return {};
        const m = { "@class": ".TeamChatMessage", chatMessageId: c.nk.uuidv4(), fromId: c.userId, who: socName(c, c.userId), message: msg, teamId: g.group.id, teamType: "GUILD", ownerId: c.userId };
        for (const u of socGuildMembers(c.nk, g.group.id)) if (u.state <= 2) gsPush(c.nk, u.uid, m, false);
        return {};
    },
};

// groupsList pages at 100; sorted guild lists need every guild (capped at 2000).
function socAllGroups(c: GsContext): nkruntime.Group[] {
    const all: nkruntime.Group[] = [];
    let cursor: string | undefined = undefined;
    do {
        const page = c.nk.groupsList(undefined, undefined, undefined, undefined, 100, cursor);
        all.push(...(page.groups || []));
        cursor = page.cursor || undefined;
    } while (cursor && all.length < 2000);
    return all;
}
