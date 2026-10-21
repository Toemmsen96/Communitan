// Custom game modes: server-defined rule switches. Design + contract: docs/design/game-modes.md
// Data: CATAN_DATA_DIR/modes/index.json {modes: [id...]} + modes/<id>.json {id, name, description, expansions,
// players:{min,max}, gameInfo:{victoryPoints?, useShuffleMap?, friendlyRobber?, diceMode?}, rules:{dice:{fixedSum},
// roundGrant:{count}}}. The rules run on every client (the mod, rules/ModeRules.cs) and in the L3 referee.
//   - a mode id travels as gameInfo.ccsMode: Free Play = matchmaker string property ccsMode (+ MatchmakingRequest
//     participantData.gameInformation.ccsMode), custom games = CreateChallenge gameInfo.ccsMode. The server validates it,
//     stores the resolved definition as gameInfo.ccsModeDef (details/state return gameInfo flat -> ccsMode + ccsModeDef).
//   - only modded clients with the "modes-1" capability may create/join/play a mode game (others would desync)
//   - mode games are unranked (no ELO/season/leaderboards; mp_game.ts mpEloRows, ranking.ts rankingRecordGame)
//   - MatchmakerAdd hook (status.ts): tickets without a mode never match mode tickets; mode tickets only match their mode

const MODE_CAPS = "modes-1";
const MODE_CAPS_MSG = "This game uses a custom game mode. Update the Communitan mod to play it.";
const MODE_UNKNOWN_MSG = "This server does not offer that game mode (any more).";
const MODE_ID_RX = /^[a-z0-9_-]{1,32}$/;
const MODE_GAMEINFO_KEYS = ["victoryPoints", "useShuffleMap", "friendlyRobber", "diceMode"];

interface ModeDef {
    id: string; name: string; description?: string; expansions: string[]; players: { min: number; max: number };
    gameInfo?: { [key: string]: any };
    rules: { dice?: { fixedSum?: number }; roundGrant?: { count?: number } };
}

// Problem with a mode file, or "" if usable.
function modeCheck(d: any, id: string): string {
    if (!d || typeof d !== "object") return "not an object";
    if (d.id !== id) return "id must be " + id;
    if (!Array.isArray(d.expansions) || d.expansions.length !== 1 || d.expansions[0] !== "CatanBaseGame") return "expansions: only [\"CatanBaseGame\"] is supported";
    const p = d.players || {};
    if (!(Number.isInteger(p.min) && Number.isInteger(p.max) && p.min >= 2 && p.max <= 4 && p.min <= p.max)) return "players: {min, max} within 2..4";
    const r = d.rules || {};
    const sum = r.dice && r.dice.fixedSum;
    if (sum !== undefined && !(Number.isInteger(sum) && sum >= 2 && sum <= 12)) return "rules.dice.fixedSum: 2..12";
    const cnt = r.roundGrant && r.roundGrant.count;
    if (cnt !== undefined && !(Number.isInteger(cnt) && cnt >= 0 && cnt <= 20)) return "rules.roundGrant.count: 0..20";
    for (const k in d.gameInfo || {}) if (MODE_GAMEINFO_KEYS.indexOf(k) < 0) return "gameInfo." + k + " not supported";
    return "";
}

// Mode definition by id (null = unknown/invalid). Files are cached per VM (dataLoadOpt).
function modeGet(ctx: nkruntime.Context, nk: nkruntime.Nakama, id: any): ModeDef | null {
    if (typeof id !== "string" || !MODE_ID_RX.test(id)) return null;
    let idx: any = null;
    try {
        idx = dataLoadOpt(ctx, nk, "modes/index.json");
    } catch (e) { /* invalid JSON: no modes */ }
    if (!idx || !Array.isArray(idx.modes) || idx.modes.indexOf(id) < 0) return null;
    let d: any = null;
    try {
        d = dataLoadOpt(ctx, nk, "modes/" + id + ".json");
    } catch (e) { /* invalid JSON */ }
    return d && !modeCheck(d, id) ? (JSON.parse(JSON.stringify(d)) as ModeDef) : null;
}

function modeList(ctx: nkruntime.Context, nk: nkruntime.Nakama): ModeDef[] {
    let idx: any = null;
    try {
        idx = dataLoadOpt(ctx, nk, "modes/index.json");
    } catch (e) { /* none */ }
    const out: ModeDef[] = [];
    for (const id of (idx && Array.isArray(idx.modes) ? idx.modes : [])) {
        const d = modeGet(ctx, nk, id);
        if (d) out.push(d);
    }
    return out;
}

// Startup log (main.ts InitModule): offered modes, broken files.
function modeLogList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama) {
    let idx: any = null;
    try {
        idx = dataLoadOpt(ctx, nk, "modes/index.json");
    } catch (e) {
        logger.error("game modes: modes/index.json: %s", String(e));
    }
    const ok: string[] = [];
    for (const id of (idx && Array.isArray(idx.modes) ? idx.modes : [])) {
        let d: any = null, why = "";
        try {
            d = dataLoadOpt(ctx, nk, "modes/" + id + ".json");
            why = d ? modeCheck(d, id) : "file missing";
        } catch (e) {
            why = String(e);
        }
        if (why) logger.error("game mode %s ignored: %s", String(id), why);
        else ok.push(id);
    }
    logger.info("game modes: %s", ok.length ? ok.join(", ") : "none");
}

// Public summary for the status (server list, mode picker).
function modeSummary(ctx: nkruntime.Context, nk: nkruntime.Nakama): any[] {
    return modeList(ctx, nk).map((d) => ({ id: d.id, name: d.name, description: d.description || "", expansions: d.expansions, players: d.players }));
}

function modeHasCaps(c: GsContext): boolean {
    return String(c.req.communitanCaps || "").split(",").indexOf(MODE_CAPS) >= 0;
}

// Resolves a requested mode id: null for none; throws the "update your mod" / "unknown mode" popup error.
function modeResolve(c: GsContext, id: any): ModeDef | null {
    if (id === undefined || id === null || id === "") return null;
    if (!modeHasCaps(c)) gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: MODE_CAPS_MSG });
    const d = modeGet(c.ctx, c.nk, id);
    if (!d) gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: MODE_UNKNOWN_MSG });
    return d;
}

// Writes the mode into a game info (after mpFreeplayShuffle: the mode's gameInfo wins). def null = strip any mode keys.
function modeApply(gi: any, def: ModeDef | null) {
    delete gi.ccsMode;
    delete gi.ccsModeDef;
    if (!def) return;
    gi.ccsMode = def.id;
    gi.ccsModeDef = def;
    for (const k of MODE_GAMEINFO_KEYS) if (def.gameInfo && def.gameInfo[k] !== undefined) gi[k] = def.gameInfo[k];
}

// The resolved definition of a session's mode (null = normal game).
function modeOf(s: { gameInfo?: any } | null | undefined): ModeDef | null {
    return (s && s.gameInfo && s.gameInfo.ccsMode && s.gameInfo.ccsModeDef) || null;
}

function modeFixedSum(s: MpSession): number {
    const d = modeOf(s);
    const v = d && d.rules && d.rules.dice && d.rules.dice.fixedSum;
    return Number.isInteger(v) ? (v as number) : 0;
}

// ---- custom lobby (mp_lobby.ts) ----
// The host's gameInfo.ccsMode travels in LOBBY_CREATE / LOBBY_UPDATE_GAME_INFO / LOBBY_START_GAME (mod: ToGSData postfix).
// The lobby keeps the id + the mode's gameInfo overrides (no ccsModeDef: CreateChallenge resolves the mode again). Every
// member must have sent "modes-1" with its last lobby request (l.modeCaps); invitees are checked at LOBBY_ACCEPT.

// Records whether the caller's mod can play modes (every lobby request carries communitanCaps).
function modeLobbyNoteCaps(c: GsContext, l: { modeCaps?: string[] }) {
    const caps = (l.modeCaps || []).filter((u) => u !== c.userId);
    if (modeHasCaps(c)) caps.push(c.userId);
    l.modeCaps = caps;
}

// Validates + applies the mode of a lobby game info (in place). start: also checks the seat count (sortedPlayerIds incl. AI).
// Expansion mismatch (host switched to another expansion) drops the mode instead of failing: the host's next update fixes it.
function modeLobbyApply(c: GsContext, l: { members: string[]; modeCaps?: string[] }, gi: any, start: boolean) {
    const mode = modeResolve(c, gi.ccsMode);
    if (mode) {
        const exps: string[] = gi.expansions || [];
        if (exps.length !== mode.expansions.length || exps.some((e) => mode.expansions.indexOf(e) < 0)) {
            c.logger.info("lobby: mode %s dropped, expansions %s", mode.id, JSON.stringify(exps));
            modeApply(gi, null);
            return;
        }
        const caps = l.modeCaps || [];
        const missing = l.members.filter((u) => caps.indexOf(u) < 0);
        if (missing.length) {
            const names = c.nk.usersGetId(missing).map((u) => u.displayName || u.username);
            gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: "Game mode " + mode.name + ": " + names.join(", ") + " must update the Communitan mod first." });
        }
        const seats = (gi.sortedPlayerIds || l.members).length;
        if (start && (seats < mode.players.min || seats > mode.players.max)) gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: "Game mode " + mode.name + " needs " + mode.players.min + "-" + mode.players.max + " players." });
    }
    modeApply(gi, mode);
    delete gi.ccsModeDef;
}

// LOBBY_ACCEPT: a client without the capability must not join a mode lobby.
function modeLobbyAccept(c: GsContext, l: { gameInfo?: any }) {
    if (l.gameInfo && l.gameInfo.ccsMode && !modeHasCaps(c)) gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: MODE_CAPS_MSG });
}

// MatchmakerAdd before-hook (status.ts): own pool per mode. Tickets without a mode exclude every mode ticket; a mode ticket
// only matches tickets of the same mode and searches the exact player count the mode allows (Free Play = min count).
function modeMatchmaker(ctx: nkruntime.Context, nk: nkruntime.Nakama, logger: nkruntime.Logger, a: nkruntime.MatchmakerAddMessage | undefined) {
    if (!a) return;
    const sp = a.stringProperties || (a.stringProperties = {});
    let q = String(a.query || "*").replace(/\s*[+-]?properties\.ccsMode:\S+/g, "").trim() || "*";
    const id = sp.ccsMode;
    if (!id) {
        a.query = q + " -properties.ccsMode:/.+/";
        return;
    }
    if (!MODE_ID_RX.test(id)) sp.ccsMode = "invalid";
    a.query = q + " +properties.ccsMode:" + sp.ccsMode;
    const d = modeGet(ctx, nk, sp.ccsMode);
    if (d) {
        const n = Math.max(d.players.min, Math.min(d.players.max, a.minCount | 0));
        a.minCount = n;
        a.maxCount = n;
    }
    logger.debug("matchmaker: mode ticket %s %s players=%d", sp.ccsMode, d ? "ok" : "unknown", a.minCount);
}

// RPC COMMUNITAN_MODES: offered modes with their full definitions. Plain JSON for http_key calls (no session), GS response
// for a LogEventRequest (like COMMUNITAN_STATUS, status.ts).
function rpcModes(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    let req: GsRequest | null = null;
    try {
        const p = payload ? JSON.parse(payload) : null;
        if (p && typeof p === "object" && p["@class"]) req = p;
    } catch (e) { /* plain call */ }
    const out = { modes: modeList(ctx, nk) };
    return req ? gsResponse(req, out) : JSON.stringify(out);
}

const MODE_HANDLERS: GsHandlerTable = {
    COMMUNITAN_MODES: (c) => ({ modes: modeList(c.ctx, c.nk) }),
};
