// Public server status (player counts) for the mod's server list + matchmaking screen. Contract: docs/protocol/core.md 5.4
// Tracking (all per-user docs, no shared counter, system-only permissions):
//   "communitan_search"/"ticket" {mode, ts}: written by the MatchmakerAdd before-hook, deleted on MatchmakerRemove and when
//     matched. The client re-adds its ticket every 60 s, so entries older than 75 s (or of offline users) are stale.
//   "communitan_online"/"seen" {ts}: refreshed by authenticated RPCs (rpcDispatch); a user counts as online only while
//     Nakama's status registry says so (socket connected).
//   playing: RUNNING "sessions" docs (mp_session.ts), humans not kicked/paused whose last request is < 2 min old.
// Mode key: "<matchType>|<expansions, sorted, comma-joined>|<min>-<max>", e.g. "QUICK_MATCH|CatanBaseGame|3-3"
// (matchType/expansions = matchmaker string properties, min/max = matchmaker counts; sessions use gameInfo's fields).

const ST_SEARCH = "communitan_search";
const ST_ONLINE = "communitan_online";
const ST_SEARCH_TTL_MS = 75000;
const ST_PLAY_TTL_MS = 120000;
const ST_CACHE_MS = 2000; // per VM; the mod polls every 5 s while searching
let ST_CACHE: { at: number; value: any } | null = null;

function stModeKey(matchType: any, expansions: any, min: any, max: any): string {
    const list: string[] = Array.isArray(expansions) ? expansions.map(String) : String(expansions || "").split(/\s+/);
    const ex = list.filter((x) => x).sort().join(",");
    return (matchType ? String(matchType) : "?") + "|" + ex + "|" + (Number(min) | 0) + "-" + (Number(max) | 0);
}

function stDoc(collection: string, key: string, userId: string, value: any): nkruntime.StorageWriteRequest {
    return { collection: collection, key: key, userId: userId, value: value, permissionRead: 0, permissionWrite: 0 };
}

function stDelete(nk: nkruntime.Nakama, collection: string, key: string, userId: string) {
    const objs = nk.storageRead([{ collection: collection, key: key, userId: userId }]);
    if (!objs.length) return;
    try {
        nk.storageDelete([{ collection: collection, key: key, userId: userId, version: objs[0].version }]);
    } catch (e) { /* changed concurrently: the newer writer wins */ }
}

// ---- hooks (never block the original message) ----
function stBeforeMatchmakerAdd(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, env: nkruntime.EnvelopeMatchmakerAdd): nkruntime.EnvelopeMatchmakerAdd {
    try {
        const a = env.matchmakerAdd;
        const sp = (a && a.stringProperties) || {};
        if (ctx.userId && a) {
            nk.storageWrite([stDoc(ST_SEARCH, "ticket", ctx.userId, { mode: stModeKey(sp.matchType, sp.expansions, a.minCount, a.maxCount), ts: Date.now() })]);
        }
    } catch (e) {
        logger.warn("status: matchmaker add tracking failed: %s", String(e));
    }
    return env;
}

function stBeforeMatchmakerRemove(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, env: nkruntime.EnvelopeMatchmakerRemove): nkruntime.EnvelopeMatchmakerRemove {
    try {
        if (ctx.userId) stDelete(nk, ST_SEARCH, "ticket", ctx.userId);
    } catch (e) {
        logger.warn("status: matchmaker remove tracking failed: %s", String(e));
    }
    return env;
}

// Returns nothing: Nakama keeps its default (relayed match + token join, docs/protocol/core.md 5.1).
function stMatchmakerMatched(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, matches: nkruntime.MatchmakerResult[]): void {
    try {
        const del: nkruntime.StorageDeleteRequest[] = [];
        for (const m of matches || []) if (m && m.presence && m.presence.userId) del.push({ collection: ST_SEARCH, key: "ticket", userId: m.presence.userId });
        if (del.length) nk.storageDelete(del);
    } catch (e) {
        logger.warn("status: matched tracking failed: %s", String(e));
    }
}

// Online candidates: any user with an authenticated RPC in the last 7 days (marker refreshed at most every 10 min
// per VM); counted only while Nakama's status registry reports them online (socket connected, appearOnline).
// The JS runtime has no session start/end events (Go only), so presence comes from the registry.
const ST_TOUCHED: { [userId: string]: number } = {};
function stTouchOnline(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string) {
    const now = Date.now();
    if (!userId || now - (ST_TOUCHED[userId] || 0) < 600000) return;
    ST_TOUCHED[userId] = now;
    try {
        nk.storageWrite([stDoc(ST_ONLINE, "seen", userId, { ts: now })]);
    } catch (e) {
        logger.warn("status: online marker failed: %s", String(e));
    }
}

// ---- counting ----
function stRows(nk: nkruntime.Nakama, sql: string, args: any[]): any[] {
    return (nk.sqlQuery(sql, args) || []) as any[];
}

function stParse(v: any): any {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return JSON.parse(v);
    return v;
}

function stCompute(c: { ctx: nkruntime.Context; nk: nkruntime.Nakama; logger: nkruntime.Logger }): any {
    const now = Date.now();
    if (ST_CACHE && now - ST_CACHE.at < ST_CACHE_MS) return ST_CACHE.value;
    const nk = c.nk;
    const modes: { [key: string]: { searching: number; playing: number } } = {};
    const mode = (k: string) => modes[k] || (modes[k] = { searching: 0, playing: 0 });

    const searchRows: any[] = [];
    for (const r of stRows(nk, "SELECT user_id::text AS u, value::text AS v FROM storage WHERE collection = $1 AND update_time > now() - interval '3 minutes' LIMIT 10000", [ST_SEARCH])) {
        const v = stParse(r.v);
        if (v && now - (v.ts || 0) <= ST_SEARCH_TTL_MS) searchRows.push({ u: String(r.u), mode: v.mode || "?" });
    }

    const players: { [userId: string]: boolean } = {};
    let playing = 0;
    for (const r of stRows(nk, "SELECT value::text AS v FROM storage WHERE collection = $1 AND user_id = $2 AND update_time > now() - interval '10 minutes' AND value->>'state' = 'RUNNING' LIMIT 5000", [MP_SESSIONS, STORE_SYSTEM_USER])) {
        const s = stParse(r.v);
        if (!s || !s.humans) continue;
        const gi = s.gameInfo || {};
        const key = stModeKey(gi.matchType || gi.connectionType, gi.expansions, gi.minPlayers, gi.maxPlayers);
        for (const u of s.humans as string[]) {
            const p = s.pres && s.pres[u];
            if (!p || p.kicked || p.paused || now - (p.seen || 0) > ST_PLAY_TTL_MS || players[u]) continue;
            players[u] = true;
            playing++;
            mode(key).playing++;
        }
    }

    const cand: { [userId: string]: boolean } = {};
    for (const r of stRows(nk, "SELECT user_id::text AS u FROM storage WHERE collection = $1 AND update_time > now() - interval '7 days' LIMIT 20000", [ST_ONLINE])) if (r.u) cand[String(r.u)] = true;
    for (const x of searchRows) cand[x.u] = true;
    const ids = Object.keys(cand);
    const isOnline: { [userId: string]: boolean } = {};
    for (let i = 0; i < ids.length; i += 100) {
        for (const u of nk.usersGetId(ids.slice(i, i + 100))) if (u.online) isOnline[u.userId] = true;
    }
    const online = Object.keys(isOnline).length;
    let searching = 0;
    for (const x of searchRows) {
        if (!isOnline[x.u]) continue;
        searching++;
        mode(x.mode).searching++;
    }

    const out: any = { online: online, playing: playing, searching: searching, modes: modes, rng: rngMode(c.ctx), entitlements: entMode(c.ctx) };
    try {
        const n = dataLoad(c.ctx, nk, "news.json");
        if (n.serverName) out.name = String(n.serverName);
        if (n.motd) out.motd = String(n.motd);
    } catch (e) { /* optional */ }
    ST_CACHE = { at: now, value: out };
    return out;
}

// RPC COMMUNITAN_STATUS. Plain JSON for http_key calls (no session, e.g. GET /v2/rpc/COMMUNITAN_STATUS?http_key=..&unwrap);
// a GS request (LogEventRequest eventKey COMMUNITAN_STATUS, in-game with a session) gets the counts as scriptData.
function rpcServerStatus(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    let req: GsRequest | null = null;
    try {
        const p = payload ? JSON.parse(payload) : null;
        if (p && typeof p === "object" && p["@class"]) req = p;
    } catch (e) { /* plain call */ }
    let status: any;
    try {
        status = stCompute({ ctx: ctx, nk: nk, logger: logger });
    } catch (e) {
        logger.error("status: %s", String(e));
        return req ? gsErrorResponse(req, { code: "SERVER_ERROR" }) : JSON.stringify({ error: "unavailable" });
    }
    return req ? gsResponse(req, status) : JSON.stringify(status);
}

const STATUS_HANDLERS: GsHandlerTable = {
    COMMUNITAN_STATUS: (c) => stCompute(c),
};
