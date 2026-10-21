// Custom match lobby. Contract: docs/protocol/multiplayer.md B2, C.2
// Lobby id doubles as challengeId (client: MultiplayerGameInformation falls back ChallengeId = lobbyId).

// modeCaps: members whose mod can play custom game modes (modes.ts modeLobbyNoteCaps)
interface MpLobby { lobbyId: string; ownerId: string; members: string[]; invited: string[]; ready: string[]; gameInfo: any; modeCaps?: string[] }

// LobbyUpdate shape. lobbyPlayers = members only (client does lobbyPlayers.Except(invitedPlayers), so this is equivalent).
function mpLobbyUpdate(c: GsContext, l: MpLobby): any {
    const d: any = {};
    for (const k in l.gameInfo || {}) d[k] = l.gameInfo[k];
    const humans = l.members.concat(l.invited);
    mpLobbySorted(l);
    d.sortedPlayerIds = l.gameInfo.sortedPlayerIds;
    d.lobbyId = l.lobbyId;
    d.ownerId = l.ownerId;
    d.lobbyPlayers = mpPlayerDetails(c, l.members, humans);
    d.invitedPlayers = mpPlayerDetails(c, l.invited, humans);
    d.readyPlayerIds = mpUniq([l.ownerId].concat(l.ready));
    d.aiPlayerIds = ((l.gameInfo && l.gameInfo.sortedPlayerIds) || []).filter((u: string) => humans.indexOf(u) < 0);
    return d;
}

function mpLobbyId(c: GsContext): string {
    const id = c.req.LOBBY_ID;
    if (!id) gsFail({ errorCode: MP_ERR.closed });
    return id;
}

// Mutates a lobby; fn may set `push` targets. Returns the stored lobby (or null if gone).
function mpLobbyMutate(c: GsContext, fn: (l: MpLobby, fx: MpFx) => boolean | void): MpLobby {
    const l = mpMutate<MpLobby>(c.nk, MP_LOBBIES, mpLobbyId(c), (cur, fx) => {
        if (!cur) {
            fx.fail = MP_ERR.closed;
            return null;
        }
        return fn(cur, fx) === false ? null : cur;
    });
    return l!;
}

function mpLobbyPush(c: GsContext, l: MpLobby, ext: string, to: string[]) {
    if (!to.length) return;
    const d = mpLobbyUpdate(c, l);
    for (const u of to) gsPushScript(c.nk, u, ext, d, false);
}

function mpLobbySorted(l: MpLobby): string[] {
    l.gameInfo = l.gameInfo || {};
    if (!l.gameInfo.sortedPlayerIds) l.gameInfo.sortedPlayerIds = l.members.slice();
    return l.gameInfo.sortedPlayerIds;
}

function mpLobbyDrop(l: MpLobby, u: string) {
    l.gameInfo.sortedPlayerIds = mpLobbySorted(l).filter((x) => x !== u);
    l.members = l.members.filter((x) => x !== u);
    l.invited = l.invited.filter((x) => x !== u);
    l.ready = l.ready.filter((x) => x !== u);
}

// ASSUMPTION: owner leaving hands ownership to the next member; empty lobby is deleted.
function mpLobbyLeave(c: GsContext, id: string) {
    const l = mpMutate<MpLobby>(c.nk, MP_LOBBIES, id, (l) => {
        if (!l) return null;
        mpLobbyDrop(l, c.userId);
        if (l.ownerId === c.userId) l.ownerId = l.members[0] || "";
        return l;
    });
    if (l && !l.members.length) c.nk.storageDelete([{ collection: MP_LOBBIES, key: id, userId: STORE_SYSTEM_USER }]);
    else if (l) mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members);
}

// Account deletion: leave every lobby c.userId is a member of or invited to.
function mpLobbyLeaveAll(c: GsContext) {
    const rows = c.nk.sqlQuery("SELECT key FROM storage WHERE collection = $1 AND user_id = $2 AND (value->'members' @> to_jsonb($3::text) OR value->'invited' @> to_jsonb($3::text))",
        [MP_LOBBIES, STORE_SYSTEM_USER, c.userId]);
    for (const r of rows) mpLobbyLeave(c, r.key);
}

const MP_LOBBY_HANDLERS: GsHandlerTable = {
    LOBBY_CREATE: (c) => {
        rngRequireCaps(c);
        const l: MpLobby = { lobbyId: c.nk.uuidv4(), ownerId: c.userId, members: [c.userId], invited: [], ready: [], gameInfo: c.req.GAME_INFO || {} };
        modeLobbyNoteCaps(c, l);
        modeLobbyApply(c, l, l.gameInfo, false); // game mode (modes.ts): validated, overrides applied
        mpMutate<MpLobby>(c.nk, MP_LOBBIES, l.lobbyId, () => l);
        return mpLobbyUpdate(c, l);
    },
    LOBBY_GET_GAMEINFO: (c) => {
        const l: MpLobby | null = mpGet(c.nk, MP_LOBBIES, mpLobbyId(c));
        if (!l) gsFail({ errorCode: MP_ERR.closed });
        return mpLobbyUpdate(c, l!);
    },
    // Owner also "invites" AI bots (Lobby.InvitePlayer): AI ids only join sortedPlayerIds (-> aiPlayerIds).
    // The server keeps sortedPlayerIds since the invite carries no GAME_INFO (ASSUMPTION: new seat appended).
    // ASSUMPTION: any member may invite; no online/in-game check (errors 22/23 never returned).
    LOBBY_INVITE: (c) => {
        const target: string = c.req.PLAYER_ID;
        const human = !!target && mpRealUsers(c.nk, [target]).length > 0;
        const l = mpLobbyMutate(c, (l) => {
            if (!target || l.members.indexOf(target) >= 0 || l.invited.indexOf(target) >= 0) return false;
            if (human) l.invited.push(target);
            const sorted = mpLobbySorted(l);
            if (sorted.indexOf(target) < 0) sorted.push(target);
        });
        if (human && l.members.indexOf(target) < 0) {
            const d: any = {};
            for (const k in l.gameInfo || {}) d[k] = l.gameInfo[k];
            d.lobbyId = l.lobbyId;
            d.player = mpPlayerDetails(c, [c.userId], [c.userId])[0];
            gsPushScript(c.nk, target, "LOBBY_INVITE", d, false);
        }
        mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members);
        return {};
    },
    LOBBY_ACCEPT: (c) => {
        rngRequireCaps(c);
        const l = mpLobbyMutate(c, (l) => {
            if (l.members.indexOf(c.userId) >= 0) return false;
            modeLobbyAccept(c, l); // mode lobby: only clients with the "modes-1" capability
            l.invited = l.invited.filter((x) => x !== c.userId);
            l.members.push(c.userId);
            modeLobbyNoteCaps(c, l);
        });
        mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members.filter((u) => u !== c.userId));
        return mpLobbyUpdate(c, l);
    },
    LOBBY_DECLINE: (c) => {
        const l = mpLobbyMutate(c, (l) => {
            if (l.invited.indexOf(c.userId) < 0) return false;
            mpLobbyDrop(l, c.userId);
        });
        mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members);
        return {};
    },
    LOBBY_PLAYER_IS_READY: (c) => {
        const ready = c.req.IS_READY == 1;
        const l = mpLobbyMutate(c, (l) => {
            l.ready = l.ready.filter((x) => x !== c.userId);
            if (ready) l.ready.push(c.userId);
            modeLobbyNoteCaps(c, l);
        });
        mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members);
        return {};
    },
    LOBBY_UPDATE_GAME_INFO: (c) => {
        const rm: string = c.req.REMOVE_PLAYER_ID || "-";
        const l = mpLobbyMutate(c, (l) => {
            modeLobbyNoteCaps(c, l);
            if (c.req.GAME_INFO) l.gameInfo = c.req.GAME_INFO;
            if (rm !== "-") mpLobbyDrop(l, rm);
            if (c.req.GAME_INFO) modeLobbyApply(c, l, l.gameInfo, false);
        });
        mpLobbyPush(c, l, "LOBBY_UPDATE_GAMEINFO", l.members.filter((u) => u !== c.userId));
        return {};
    },
    LOBBY_KICK: (c) => {
        const target: string = c.req.PLAYER_ID;
        const l = mpLobbyMutate(c, (l) => {
            if (c.userId !== l.ownerId || !target || target === l.ownerId) return false;
            mpLobbyDrop(l, target);
        });
        if (target && target !== l.ownerId && mpRealUsers(c.nk, [target]).length) gsPushScript(c.nk, target, "LOBBY_GOT_KICKED", {}, false);
        mpLobbyPush(c, l, "LOBBY_UPDATE_PLAYERS", l.members);
        return {};
    },
    LOBBY_LEAVE: (c) => {
        mpLobbyLeave(c, mpLobbyId(c));
        return {};
    },
    // ASSUMPTION: canStart only requires every member to be ready (owner implicit); no min-human check.
    LOBBY_START_GAME: (c) => {
        const gi = (c.req.GAME_INFO && c.req.GAME_INFO.gameInfo) || c.req.GAME_INFO || {};
        let can = false;
        const l = mpLobbyMutate(c, (l) => {
            can = l.ownerId === c.userId && l.members.every((u) => u === l.ownerId || l.ready.indexOf(u) >= 0);
            if (!can) return false;
            modeLobbyApply(c, l, gi, true); // mode: every member's caps + the mode's seat count
            l.gameInfo = gi;
        });
        if (!can) return { canStart: false };
        const d: any = {};
        for (const k in gi) d[k] = gi[k];
        d.lobbyId = l.lobbyId;
        d.challengeId = l.lobbyId;
        if (!d.sortedPlayerIds) d.sortedPlayerIds = l.members.slice();
        for (const u of l.members) if (u !== c.userId) gsPushScript(c.nk, u, "LOBBY_START_GAME", d, false);
        const resp: any = { canStart: true };
        for (const k in d) resp[k] = d[k];
        return resp;
    },
};
