// Multiplayer session store, presence, pushes. Contract: docs/protocol/multiplayer.md
// Storage (system-owned): "sessions"/<challengeId> = MpSession (OCC writes), "session_actions"/<challengeId>#<n> = action
// chunks, "mp_user"/"current" (per user) = pointer to the user's running session (+ kicked flag), "mp_stats"/"main" = ELO/XP.
// Timers: Nakama JS has no setTimeout -> ping timeouts and kick timers are evaluated lazily (mpTick) whenever any
// participant of the session sends a request (pings every 25 s keep this ticking while anyone is connected).

const MP_SESSIONS = "sessions";
const MP_ACTIONS = "session_actions";
const MP_MATCHES = "mm_matches";
const MP_LOBBIES = "lobbies";
const MP_USERS = "mp_user";
const MP_STATS = "mp_stats";
const MP_CHUNK = 64;
const MP_PING_TIMEOUT_MS = 60000; // ASSUMPTION: client pings every 25 s and assumes 35 s; 60 s tolerates load hiccups
const MP_KICK_MS = 180000;        // ASSUMPTION: kick timer length
const MP_AFK_LIMIT = 3;           // KickReason.AFK_3X_TURNTIMER
const MP_ERR = { closed: 24, kicked: 46, progress: 110, lastAction: 111 };

interface MpPres { seen: number; paused?: number; kicked?: string; afk: number; inGame?: boolean }
interface MpSession {
    id: string; gen: string; state: string; created: number; ended?: number;
    creatorId: string; gameInfo: any; seed: number; colorSeed: number; diceSeed: number;
    clientSeeds?: number[]; rng?: string; // creator's [seed, colorSeed, diceSeed] (durable-retry check); RNG level at creation
    rngU?: { [uniqueId: string]: number }; rngStack?: number[]; // rng "full" (mp_rng.ts): UniqueId -> first action index; dice deck
    seats: string[]; humans: string[]; spectatorId?: string; hostIdx: number;
    nActions: number; lastPlayed: { [seat: string]: number }; tt: { [seat: string]: number }; ctx: any; recent: string[];
    ready: string[]; startedIds: string[]; logicStarted: boolean;
    l3?: string; // inline referee stopped for this session (referee.ts refCheckAction): reason
    pres: { [userId: string]: MpPres }; muted: { [userId: string]: string[] }; result?: any;
}

class MpFx {
    pushes: { userId: string; msg: any; persistent: boolean }[] = [];
    writes: nkruntime.StorageWriteRequest[] = []; // committed atomically with the record
    after: nkruntime.StorageWriteRequest[] = [];  // best effort after commit (user pointers, stats)
    fail: number = 0;                              // commit, then answer with this errorCode
    failMsg: string = "";                          // optional customErrorMessage (shown by the client's error popup)
    script(userIds: string[], ext: string, data: any, persistent = false) {
        for (const u of userIds) this.pushes.push({ userId: u, msg: { "@class": ".ScriptMessage", extCode: ext, data: data }, persistent: persistent });
    }
}

function mpObj(coll: string, key: string, value: any, version?: string, userId = STORE_SYSTEM_USER): nkruntime.StorageWriteRequest {
    const r: nkruntime.StorageWriteRequest = { collection: coll, key: key, userId: userId, value: value, permissionRead: 0, permissionWrite: 0 };
    if (version) r.version = version;
    return r;
}

function mpGet(nk: nkruntime.Nakama, coll: string, key: string, userId = STORE_SYSTEM_USER): any {
    const v = storeGet(nk, coll, key, userId);
    return v ? JSON.parse(JSON.stringify(v)) : v;
}

// Optimistic read-modify-write of one system record. fn returns the new value, or null/undefined for "no write".
function mpMutate<T>(nk: nkruntime.Nakama, coll: string, key: string, fn: (cur: T | null, fx: MpFx) => T | null | undefined): T | null {
    for (let attempt = 0; ; attempt++) {
        const fx = new MpFx();
        const objs = nk.storageRead([{ collection: coll, key: key, userId: STORE_SYSTEM_USER }]);
        // plain JS copy: values from storageRead are Go-backed; arrays assigned into them get copied, so later pushes would be lost
        const cur = objs.length ? (JSON.parse(JSON.stringify(objs[0].value)) as T) : null;
        const next = fn(cur, fx);
        const writes = fx.writes.slice();
        if (next) writes.unshift(mpObj(coll, key, next, objs.length ? objs[0].version : "*"));
        if (writes.length) {
            try {
                nk.storageWrite(writes);
            } catch (e) {
                if (attempt < 8) continue; // version conflict: concurrent writer, retry on fresh data
                throw e;
            }
        }
        mpFlush(nk, fx);
        if (fx.fail) gsFail(fx.failMsg ? { errorCode: fx.fail, customErrorMessage: fx.failMsg } : { errorCode: fx.fail });
        return next || cur;
    }
}

function mpFlush(nk: nkruntime.Nakama, fx: MpFx) {
    if (fx.after.length) nk.storageWrite(fx.after);
    for (const p of fx.pushes) {
        p.msg.messageId = nk.uuidv4();
        gsPush(nk, p.userId, p.msg, p.persistent);
    }
}

// ---- per-user pointer ----
function mpUserGet(nk: nkruntime.Nakama, userId: string): { challengeId?: string; kicked?: { challengeId: string; reason: string } } {
    return mpGet(nk, MP_USERS, "current", userId) || {};
}
function mpUserPut(fx: MpFx, userId: string, v: any) {
    fx.after.push(mpObj(MP_USERS, "current", v, undefined, userId));
}

// ---- player details ----
const MP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids of existing Nakama users (AI seat ids are not users).
function mpRealUsers(nk: nkruntime.Nakama, ids: string[]): string[] {
    const q = ids.filter((u) => typeof u === "string" && MP_UUID.test(u));
    return q.length ? nk.usersGetId(q).map((u) => u.userId) : [];
}
function mpStatsGet(nk: nkruntime.Nakama, ids: string[]): { [id: string]: any } {
    const out: { [id: string]: any } = {};
    if (!ids.length) return out;
    for (const o of nk.storageRead(ids.map((u) => ({ collection: MP_STATS, key: "main", userId: u })))) out[o.userId] = JSON.parse(JSON.stringify(o.value));
    return out;
}

// PlayerDetails list in the given order; ids that are not humans are AI seats.
function mpPlayerDetails(c: GsContext, ids: string[], humans: string[]): any[] {
    const hs = ids.filter((u) => humans.indexOf(u) >= 0 && MP_UUID.test(u));
    const users: { [id: string]: nkruntime.User } = {};
    if (hs.length) for (const u of c.nk.usersGetId(hs)) users[u.userId] = u;
    const profiles: { [id: string]: any } = {};
    if (hs.length) for (const o of c.nk.storageRead(hs.map((u) => ({ collection: "profile", key: "main", userId: u })))) profiles[o.userId] = o.value;
    const stats = mpStatsGet(c.nk, hs);
    return ids.map((id) => {
        const u = users[id];
        if (!u) {
            // AI seat: same template GAME_GET_AI_PLAYERDETAILS serves (content.ts), else a bare AI entry.
            let ai: any = null;
            try { ai = contentAiPlayers().filter((a) => a.userId === id)[0]; } catch (e) { /* content not loaded */ }
            const d: any = { userId: id, displayName: id, isAi: humans.indexOf(id) < 0 };
            if (ai) for (const k in ai) d[k] = ai[k];
            d.id = id;
            d.online = true;
            d.ingame = true;
            return d;
        }
        let d: any;
        try {
            d = profiles[id] ? profileFlat(c, id, profiles[id], false) : { userId: id, displayName: u.displayName || u.username, karma: 3.0 };
        } catch (e) {
            d = { userId: id, displayName: u.displayName || u.username };
        }
        const st = stats[id];
        if (st) {
            d.elo = d.elo || {};
            for (const k in st.elo || {}) d.elo[k] = st.elo[k];
            d.eloPlacement = st.eloPlacement || {};
        }
        d.id = id;
        d.online = u.online;
        d.ingame = true;
        return d;
    });
}

// ---- session helpers ----
function mpActive(s: MpSession): string[] {
    const r = s.humans.filter((u) => !(s.pres[u] && s.pres[u].kicked));
    if (s.spectatorId && r.indexOf(s.spectatorId) < 0) r.push(s.spectatorId);
    return r;
}
function mpOthers(s: MpSession, userId: string): string[] {
    return mpActive(s).filter((u) => u !== userId);
}
function mpGameInfoFlat(s: MpSession): any {
    const d: any = {};
    for (const k in s.gameInfo || {}) d[k] = s.gameInfo[k];
    d.challengeId = s.id;
    return d;
}
function mpLastPlayedList(s: MpSession): any[] {
    return Object.keys(s.lastPlayed).map((k) => ({ playerIndex: parseInt(k, 10), lastPlayed: s.lastPlayed[k] }));
}
function mpKickedIds(s: MpSession): string[] {
    return s.humans.filter((u) => s.pres[u] && s.pres[u].kicked);
}

// ASSUMPTION: host = lowest seat of a present (not paused, not kicked) human; else lowest non-kicked human.
function mpElectHost(s: MpSession): boolean {
    let best = -1, fallback = -1;
    for (let i = 0; i < s.seats.length; i++) {
        const p = s.pres[s.seats[i]];
        if (!p || p.kicked || s.humans.indexOf(s.seats[i]) < 0) continue;
        if (fallback < 0) fallback = i;
        if (best < 0 && !p.paused) best = i;
    }
    const h = best >= 0 ? best : fallback;
    if (h < 0 || h === s.hostIdx) return false;
    s.hostIdx = h;
    return true;
}

function mpKickTimers(s: MpSession, now: number): any[] {
    const useKick = !s.gameInfo || s.gameInfo.useKicktimer !== false;
    return s.humans.filter((u) => s.pres[u] && s.pres[u].paused && !s.pres[u].kicked).map((u) => ({
        playerId: u, isKickTimerRunning: useKick, playerTimer: Math.max(0, (s.pres[u].paused! + MP_KICK_MS - now) / 1000),
    }));
}

function mpPause(s: MpSession, userId: string, now: number, fx: MpFx) {
    const p = s.pres[userId];
    if (!p || p.kicked || p.paused) return;
    p.paused = now;
    mpElectHost(s);
    fx.script(mpOthers(s, userId), "GAME_PAUSED", { challengeId: s.id, playerId: userId, isPaused: true, playerData: mpKickTimers(s, now), hostIdx: s.hostIdx });
}

function mpUnpause(s: MpSession, userId: string, now: number, fx: MpFx) {
    const p = s.pres[userId];
    if (!p || p.kicked || !p.paused) return;
    delete p.paused;
    p.seen = now;
    mpElectHost(s);
    fx.script(mpOthers(s, userId), "GAME_PAUSED", { challengeId: s.id, playerId: userId, isPaused: false, playerData: mpKickTimers(s, now), hostIdx: s.hostIdx });
}

// Seat becomes AI (host takes over). voluntary = own quit: no "you were kicked" flag on the user's pointer.
function mpKick(s: MpSession, userId: string, reason: string, voluntary: boolean, fx: MpFx) {
    const p = s.pres[userId];
    if (!p || p.kicked) return;
    const notify = mpActive(s);
    p.kicked = reason;
    delete p.paused;
    mpElectHost(s);
    // ccsKickReason: custom field (the client has no reason here); the mod shows a matching text (Communitan/KickReasonText.cs)
    fx.script(notify, "GAME_PLAYER_WAS_KICKED", { challengeId: s.id, playerId: userId, hostIdx: s.hostIdx, ccsKickReason: reason });
    if (reason === "AFK_3X_TURNTIMER") fx.script([userId], "GAME_PLAYER_AFK_KICKED", { challengeId: s.id });
    mpUserPut(fx, userId, voluntary ? {} : { kicked: { challengeId: s.id, reason: reason } });
}

// Lazy timers: ping timeout -> pause; kick timer expiry -> kick.
function mpTick(s: MpSession, now: number, fx: MpFx) {
    const useKick = !s.gameInfo || s.gameInfo.useKicktimer !== false;
    for (const u of s.humans) {
        const p = s.pres[u];
        if (!p || p.kicked) continue;
        if (!p.paused && s.startedIds.indexOf(u) >= 0 && now - p.seen > MP_PING_TIMEOUT_MS) mpPause(s, u, now, fx);
        if (p.paused && useKick && now - p.paused > MP_KICK_MS) mpKick(s, u, "KICKTIMER", false, fx);
    }
}

function mpChallengeId(c: GsContext): string {
    const r = c.req;
    return r.challengeInstanceId || r.CHALLENGE_ID || mpUserGet(c.nk, c.userId).challengeId || "";
}

// Mutates the caller's session: touch presence + lazy timers, then fn. Errors: 24 unknown/closed.
function mpGame(c: GsContext, fn: (s: MpSession, fx: MpFx, now: number) => any): any {
    const id = mpChallengeId(c);
    if (!id) gsFail({ errorCode: MP_ERR.closed });
    let out: any = {};
    mpMutate<MpSession>(c.nk, MP_SESSIONS, id, (s, fx) => {
        out = {};
        if (!s || s.state === "COMPLETED") {
            fx.fail = MP_ERR.closed;
            return null;
        }
        const now = Date.now();
        const p = s.pres[c.userId];
        if (p && !p.kicked) p.seen = now;
        mpTick(s, now, fx);
        out = fn(s, fx, now);
        return s;
    });
    return out;
}

function mpIsKicked(s: MpSession, userId: string): boolean {
    return !!(s.pres[userId] && s.pres[userId].kicked);
}

// Leave a session for good (GAME_EXIT_SESSION, forced quit, stale session when starting a new game).
function mpExitSession(c: GsContext, id: string) {
    if (!id) return;
    mpMutate<MpSession>(c.nk, MP_SESSIONS, id, (s, fx) => {
        if (!s || s.state === "COMPLETED" || s.humans.indexOf(c.userId) < 0 || mpIsKicked(s, c.userId)) {
            const ptr = mpUserGet(c.nk, c.userId);
            if (ptr.challengeId === id) mpUserPut(fx, c.userId, {});
            return null;
        }
        mpKick(s, c.userId, "UNKNOWN", true, fx);
        return s;
    });
}
