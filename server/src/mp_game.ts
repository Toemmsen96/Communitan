// In-game: setup handshake, action relay, state, presence, chat/mute, finish. Contract: docs/protocol/multiplayer.md B3-B5, C.3-C.5
// Server never interprets action blobs; it orders them (per-seat ACTION_ID), stores them for replay and relays them.

const MP_TURNTIMER_DEFAULT = 90;
const MP_ELO_K = 32;

function mpAction(c: GsContext, turntimer: boolean): any {
    const r = c.req;
    const seat = r.ACTION_OWNER_INDEX | 0;
    const aid = r.ACTION_ID | 0;
    let blob = String(r.GAME_ACTION_STATE || "");
    const ranOut: string = r.TURNTIMER_RAN_OUT_PLAYER_ID || "-";
    const hash = c.nk.sha256Hash(seat + ":" + aid + ":" + blob);
    const caps = rngHasCaps(c);
    return mpGame(c, (s, fx, now) => {
        if (mpIsKicked(s, c.userId)) {
            fx.fail = MP_ERR.kicked;
            return {};
        }
        const full = s.rng === "full";
        if (full && !caps) {
            fx.fail = RNG_ERR_CAPS;
            fx.failMsg = RNG_CAPS_MSG;
            return {};
        }
        mpUnpause(s, c.userId, now, fx);
        const k = String(seat);
        const chunks: { [key: string]: nkruntime.StorageObject | null } = {};
        const chunkOf = (i: number) => {
            const key = s.id + "#" + Math.floor(i / MP_CHUNK);
            if (chunks[key] === undefined) {
                const o = c.nk.storageRead([{ collection: MP_ACTIONS, key: key, userId: STORE_SYSTEM_USER }]);
                chunks[key] = o.length && o[0].value.gen === s.gen ? o[0] : null;
            }
            return chunks[key];
        };
        const recOf = (i: number): RngRec | null => {
            const o = chunkOf(i);
            return (o && o.value.r && o.value.r[i % MP_CHUNK]) || null;
        };
        // durable retry of an accepted action (same seat/id/blob): same answer, no new store/relay
        const seen = s.recent.filter((x) => x.split("#")[0] === hash)[0];
        if (seen !== undefined) {
            const out: any = { lastPlayedActionId: s.lastPlayed[k] };
            if (full && seen.indexOf("#") > 0) out.ccsRng = rngPublic(recOf(parseInt(seen.split("#")[1], 10)));
            return out;
        }
        // ASSUMPTION: ACTION_ID (= NetworkSyncId, shared by all actions of one context) may repeat but never go back per seat;
        // a turntimer expiry is accepted once per (seat, ACTION_ID) - later copies get 111 (= "already played" for turntimers).
        const last = s.lastPlayed[k];
        if ((last !== undefined && aid < last) || (turntimer && s.tt[k] !== undefined && aid <= s.tt[k])) {
            fx.fail = MP_ERR.lastAction;
            return {};
        }
        const idx = s.nActions;
        let rec: RngRec | undefined;
        if (full) {
            const res = rngAccept(c.nk, s, blob, idx, recOf);
            if (res.fail) {
                c.logger.warn("rng: action refused (%d) challenge=%s seat=%d id=%d", res.fail, s.id, seat, aid);
                fx.fail = res.fail;
                return {};
            }
            blob = res.blob!;
            rec = res.r;
        }
        const ck = Math.floor(idx / MP_CHUNK);
        const key = s.id + "#" + ck;
        const cur = chunkOf(idx);
        const chunk = cur ? JSON.parse(JSON.stringify(cur.value)) : { gen: s.gen, a: [] };
        chunk.a[idx - ck * MP_CHUNK] = blob;
        if (rec) {
            chunk.r = chunk.r || [];
            chunk.r[idx - ck * MP_CHUNK] = rec;
        }
        const vObjs = c.nk.storageRead([{ collection: MP_ACTIONS, key: key, userId: STORE_SYSTEM_USER }]);
        fx.writes.push(mpObj(MP_ACTIONS, key, chunk, vObjs.length ? vObjs[0].version : "*"));
        s.nActions = idx + 1;
        s.lastPlayed[k] = aid;
        if (turntimer) s.tt[k] = aid;
        const ctxs = (r.CONTEXTS && r.CONTEXTS.contexts) || [];
        if (ctxs.length) {
            const x = ctxs[ctxs.length - 1];
            s.ctx = { contextSwitchId: x.contextSwitchId, contextId: x.contextId, nextUniqueId: x.nextUniqueId, previousContextId: x.previousContextId,
                lastPlayedUniqueId: x.lastPlayedUniqueId, lastPlayedActionIdContext: x.lastPlayedActionIdContext };
        }
        s.recent.push(rec ? hash + "#" + idx : hash);
        if (s.recent.length > 32) s.recent.shift();
        const d: any = { gameActionState: blob, actionOwnerId: seat, lastPlayedActionId: aid, playerId: c.userId, challengeId: s.id };
        if (rec) d.ccsRng = rngPublic(rec);
        const ti = r.TURNTIMER_INFO;
        if (ti && ti.playerIdx !== undefined && ti.playerIdx > -1) {
            d.turntimer_playerIdx = ti.playerIdx | 0;
            d.turntimer_timer = +ti.timer || 0;
        }
        fx.script(mpOthers(s, c.userId), turntimer ? "GAME_ACTION_TURNTIMER_PLAYED" : "GAME_ACTION_PLAYED", d);
        // AFK: 3 consecutive turn timer expiries of a human; own regular action resets. ASSUMPTION: "consecutive".
        if (turntimer && s.pres[ranOut] && !s.pres[ranOut].kicked) {
            s.pres[ranOut].afk++;
            if (s.pres[ranOut].afk >= MP_AFK_LIMIT) mpKick(s, ranOut, "AFK_3X_TURNTIMER", false, fx);
        } else if (!turntimer && ranOut === "-" && s.seats[seat] === c.userId) {
            s.pres[c.userId].afk = 0;
        }
        const out: any = { lastPlayedActionId: aid };
        if (rec) out.ccsRng = rngPublic(rec);
        return out;
    });
}

function mpDetails(c: GsContext, s: MpSession): any {
    const d = mpGameInfoFlat(s);
    d.seed = s.seed;
    d.colorSeed = s.colorSeed;
    d.diceSeed = s.diceSeed;
    d.hostIdx = s.hostIdx;
    d.playerDetails = mpPlayerDetails(c, s.seats, s.humans);
    d.kickedPlayerDetails = mpPlayerDetails(c, mpKickedIds(s), s.humans);
    d.allLastPlayedActionsPerPlayer = mpLastPlayedList(s);
    d.reportedPlayers = [];
    if (s.rng === "full") {
        d.ccsRngMode = "full"; // the mod turns its RNG patches on for this challenge (mp_rng.ts)
        d.ccsRngGen = s.gen;   // lobby rematches reuse the challenge id: the mod drops records of an older session
    }
    return d;
}

// Stored blobs in order (+ per-action rng records for "full" sessions, same order).
function mpActions(c: GsContext, s: MpSession): { a: string[]; r: (RngRec | null)[] } {
    const keys: nkruntime.StorageReadRequest[] = [];
    for (let i = 0; i * MP_CHUNK < s.nActions; i++) keys.push({ collection: MP_ACTIONS, key: s.id + "#" + i, userId: STORE_SYSTEM_USER });
    const byKey: { [k: string]: any } = {};
    if (keys.length) for (const o of c.nk.storageRead(keys)) if (o.value.gen === s.gen) byKey[o.key] = o.value;
    const out: string[] = [], recs: (RngRec | null)[] = [];
    for (const k of keys) {
        const v = byKey[k.key] || { a: [] };
        for (let i = 0; i < v.a.length; i++) {
            out.push(v.a[i]);
            recs.push((v.r && v.r[i]) || null);
        }
    }
    return { a: out.slice(0, s.nActions), r: recs.slice(0, s.nActions) };
}

// "full" sessions: clients without the mod capability must not play (they would desync); clear popup instead.
function mpRngGate(c: GsContext, s: MpSession, fx: MpFx): boolean {
    if (s.rng !== "full" || rngHasCaps(c)) return true;
    fx.fail = RNG_ERR_CAPS;
    fx.failMsg = RNG_CAPS_MSG;
    return false;
}

function mpSetupReady(c: GsContext): any {
    return mpGame(c, (s, fx) => {
        if (mpIsKicked(s, c.userId)) {
            fx.fail = MP_ERR.kicked;
            return {};
        }
        if (s.ready.indexOf(c.userId) < 0) {
            s.ready.push(c.userId);
            fx.script(mpOthers(s, c.userId), "GAME_SCENE_LOADED", { playerId: c.userId, challengeId: s.id });
        }
        const all = mpActive(s).every((u) => s.ready.indexOf(u) >= 0);
        // SETUP_READY is resent every 3 s until START arrives (also after rejoin) -> late senders get START again.
        if (all && !s.logicStarted) {
            s.logicStarted = true;
            fx.script(mpActive(s), "GAME_START_GAMELOGIC", { challengeId: s.id });
        } else if (s.logicStarted) {
            fx.script([c.userId], "GAME_START_GAMELOGIC", { challengeId: s.id });
        }
        return {};
    });
}

// includeSelf: the client lists itself in GAME_TRADE's PLAYER_IDS and only processes its own offer/answer/finish
// when it comes back (RTTDistributionController multiplayer path has no local delivery, unlike single player).
function mpRelay(c: GsContext, ext: string, data: (s: MpSession) => any, to?: (s: MpSession) => string[], includeSelf = false): any {
    return mpGame(c, (s, fx) => {
        const ids = to ? to(s).filter((u) => (includeSelf || u !== c.userId) && mpActive(s).indexOf(u) >= 0) : mpOthers(s, c.userId);
        fx.script(ids, ext, data(s));
        return {};
    });
}

function mpEloRows(c: GsContext, s: MpSession, fx: MpFx): any[] {
    const r = c.req;
    const wl: any[] = (r.WIN_LOSE && r.WIN_LOSE.win_lose) || [];
    const vp = (e: any) => +(e.victorypoints !== undefined ? e.victorypoints : e.vp) || 0;
    const sorted = wl.slice().sort((a, b) => vp(b) - vp(a));
    const rank: { [id: string]: number } = {};
    for (const e of wl) rank[e.playerId] = e.rank !== undefined ? e.rank | 0 : sorted.filter((x) => vp(x) > vp(e)).length + 1;
    let exp: string = r.EXPANSION || ((s.gameInfo.expansions || [])[0]) || "CatanBaseGame";
    const mt = s.gameInfo.matchType;
    const ranked = mt === "AUTO_MATCH" || mt === "QUICK_MATCH"; // ASSUMPTION: custom matches are unranked
    const stats = mpStatsGet(c.nk, s.humans);
    const ranked_h = s.humans.filter((u) => rank[u] !== undefined);
    const before: { [id: string]: number } = {};
    for (const u of s.humans) before[u] = (stats[u] && stats[u].elo && stats[u].elo[exp]) || 1000;
    const rows: any[] = [];
    for (const id of s.seats) {
        const human = s.humans.indexOf(id) >= 0;
        let inc = 0;
        if (human && ranked && ranked_h.length > 1 && rank[id] !== undefined) {
            let sum = 0;
            for (const o of ranked_h) {
                if (o === id) continue;
                const e = 1 / (1 + Math.pow(10, (before[o] - before[id]) / 400));
                const sc = rank[id] < rank[o] ? 1 : rank[id] === rank[o] ? 0.5 : 0;
                sum += sc - e;
            }
            inc = Math.max(-100, Math.min(100, Math.round((MP_ELO_K * sum) / (ranked_h.length - 1))));
        }
        const xp = human ? (rank[id] === 1 ? 100 : 50) : 0; // ASSUMPTION: flat XP
        const st = (human && stats[id]) || { elo: {}, eloPlacement: {}, xp: 0, played: 0, won: 0 };
        const placed = ((st.eloPlacement && st.eloPlacement[exp]) || 0) + (ranked && human ? 1 : 0);
        if (human) {
            st.elo = st.elo || {};
            st.eloPlacement = st.eloPlacement || {};
            st.elo[exp] = before[id] + inc;
            st.eloPlacement[exp] = placed;
            st.xp = (st.xp || 0) + xp;
            st.played = (st.played || 0) + 1;
            if (rank[id] === 1) st.won = (st.won || 0) + 1;
            fx.after.push(mpObj(MP_STATS, "main", st, undefined, id));
        }
        rows.push({ playerId: id, rank: rank[id] || 0, xpEarned: xp, eloBefore: human ? before[id] : 1000, increaseElo: inc, placementMatchesPlayed: placed, karma: 5 });
    }
    return rows;
}

function mpWon(c: GsContext): any {
    const r = c.req;
    if (r.SINGLEPLAYER == 1 || !r.CHALLENGE_ID) return {};
    mpMutate<MpSession>(c.nk, MP_SESSIONS, r.CHALLENGE_ID, (s, fx) => {
        if (!s || s.state === "COMPLETED") return null; // idempotent (durable retries, several senders)
        const now = Date.now();
        const data = {
            challengeId: s.id, win_lose: mpEloRows(c, s, fx), gameInfo: { isSeason: !!s.gameInfo.isSeason, sortedPlayerIds: s.seats },
            startDate: new Date(s.created).toISOString(), endDate: new Date(now).toISOString(),
        };
        rankingRecordGame(c.nk, c.logger, s, r.EXPANSION, data.win_lose, fx); // RANKING (ranking.ts): leaderboards, season fields, LEVEL_PROGRESS
        s.state = "COMPLETED";
        s.ended = now;
        s.result = data;
        const notify = mpActive(s);
        const ptrs = c.nk.storageRead(notify.map((u) => ({ collection: MP_USERS, key: "current", userId: u })));
        for (const o of ptrs) if (o.value.challengeId === s.id) mpUserPut(fx, o.userId, {});
        // Persist only for offline participants (drained at their next login). Persisted copies are never deleted by a
        // client that got the live push, so online players would see the old result again at every later login.
        const online: { [id: string]: boolean } = {};
        const real = notify.filter((u) => MP_UUID.test(u));
        if (real.length) for (const u of c.nk.usersGetId(real)) online[u.userId] = !!u.online;
        fx.script(notify.filter((u) => online[u]), "GAME_MULTIPLAYER_RESULT", data, false);
        fx.script(notify.filter((u) => !online[u]), "GAME_MULTIPLAYER_RESULT", data, true);
        return s;
    });
    return {};
}

// Presence flag only; no session (menu, finished game) is not an error.
function mpInGame(c: GsContext, v: boolean): any {
    if (!mpChallengeId(c)) return {};
    try {
        return mpGame(c, (s) => {
            if (s.pres[c.userId]) s.pres[c.userId].inGame = v;
            return {};
        });
    } catch (e) {
        if (e instanceof GsError) return {};
        throw e;
    }
}

function mpTurntimers(): any {
    const t: any = {};
    for (const e of ACC_EXPANSION_NAMES) t[e] = MP_TURNTIMER_DEFAULT;
    return { turntimers: { default: t, start: t, passive: t } };
}

const MP_GAME_HANDLERS: GsHandlerTable = {
    GAME_GET_GAME_DETAILS_V3: (c) => mpGame(c, (s, fx) => (mpRngGate(c, s, fx) ? mpDetails(c, s) : {})),
    GAME_GET_GAME_DETAILS: (c) => mpGame(c, (s, fx) => (mpRngGate(c, s, fx) ? mpDetails(c, s) : {})),
    GAME_GET_GAMESTATE_AND_ACTIONS_V3: (c) => mpGame(c, (s, fx) => {
        if (!mpRngGate(c, s, fx)) return {};
        const d = mpDetails(c, s);
        for (const k of ["contextSwitchId", "lastPlayedUniqueId", "nextUniqueId"]) d[k] = (s.ctx[k] | 0);
        for (const k of ["contextId", "previousContextId", "lastPlayedActionIdContext"]) if (s.ctx[k] !== undefined && s.ctx[k] !== null) d[k] = String(s.ctx[k]);
        const acts = mpActions(c, s);
        d.gameActions = acts.a;
        if (s.rng === "full") d.ccsRng = acts.r.map(rngPublic); // same order as gameActions; the mod stashes words before replay
        return d;
    }),
    GAME_PLAYER_SETUP_READY: mpSetupReady,
    GAME_HOST_SETUP_READY: mpSetupReady,
    GAME_HOST_ACCEPTED: (c) => mpGame(c, () => ({})),
    GAME_PLAYER_HAS_STARTED_GAMELOGIC: (c) => mpGame(c, (s, fx) => {
        if (mpIsKicked(s, c.userId)) {
            fx.fail = MP_ERR.kicked;
            return {};
        }
        if (s.startedIds.indexOf(c.userId) < 0) s.startedIds.push(c.userId);
        return { playersStartedIds: s.startedIds };
    }),
    GAME_PLAYER_IN_GAME: (c) => mpInGame(c, true),
    GAME_PLAYER_NOT_IN_GAME: (c) => mpInGame(c, false),
    GAME_STILL_IN_GAME: (c) => {
        const s: MpSession | null = mpGet(c.nk, MP_SESSIONS, mpChallengeId(c) || "-");
        return { isInGame: !!s && s.state !== "COMPLETED" && (s.humans.indexOf(c.userId) >= 0 || s.spectatorId === c.userId) && !mpIsKicked(s, c.userId) };
    },
    GAME_ACTION_V3: (c) => mpAction(c, false),
    GAME_ACTION_TURNTIMER: (c) => mpAction(c, true),
    GAME_TRADE: (c) => mpRelay(c, "GAME_TRADE", (s) => {
        const r = c.req;
        const d: any = { playerIds: (r.PLAYER_IDS && r.PLAYER_IDS.playerIds) || [], trade: r.TRADE, tradeType: r.TRADE_TYPE, challengeId: s.id };
        const ti = r.TURNTIMER_INFO;
        if (ti && ti.playerIdx !== undefined && ti.playerIdx > -1) {
            d.turntimer_playerIdx = ti.playerIdx | 0;
            d.turntimer_timer = +ti.timer || 0;
        }
        return d;
    }, () => (c.req.PLAYER_IDS && c.req.PLAYER_IDS.playerIds) || [], true),
    GAME_MULTICAST_TURNTIMERS: (c) => mpRelay(c, "GAME_MULTICAST_TURNTIMERS", (s) => ({ timers: (c.req.TIMERS && c.req.TIMERS.timers) || [], challengeId: s.id })),
    GAME_PING_V3: (c) => mpGame(c, (s, fx, now) => {
        if (mpIsKicked(s, c.userId)) {
            fx.fail = MP_ERR.kicked;
            return {};
        }
        mpUnpause(s, c.userId, now, fx);
        return { allLastPlayedActionsPerPlayer: mpLastPlayedList(s), hostIdx: s.hostIdx };
    }),
    GAME_GET_KICKTIMERS: (c) => mpGame(c, (s, fx, now) => ({ playerData: mpKickTimers(s, now) })),
    GAME_GET_TURNTIMERS: () => mpTurntimers(),
    GAME_PLAYER_LEFT: (c) => mpGame(c, (s, fx, now) => {
        if (mpIsKicked(s, c.userId)) return {};
        // ASSUMPTION: explicit quit replaces the seat with AI right away; background/menu only pauses (kick timer runs).
        if (String(c.req.FORCED_QUIT).toLowerCase() === "true") mpKick(s, c.userId, "UNKNOWN", true, fx);
        else mpPause(s, c.userId, now, fx);
        return {};
    }),
    GAME_PLAYER_RETURNED: (c) => mpGame(c, (s, fx, now) => {
        if (mpIsKicked(s, c.userId)) fx.fail = MP_ERR.kicked;
        else mpUnpause(s, c.userId, now, fx);
        return {};
    }),
    GAME_EXIT_SESSION: (c) => {
        mpExitSession(c, mpUserGet(c.nk, c.userId).challengeId || "");
        return {};
    },
    GAME_SET_PLAYER_MUTED: (c) => mpGame(c, (s) => {
        const pid: string = c.req.PLAYER_ID;
        const m = (s.muted[c.userId] || []).filter((u) => u !== pid);
        if (c.req.IS_MUTED == 1 && pid) m.push(pid);
        s.muted[c.userId] = m;
        return {};
    }),
    GAME_GET_MUTED_PLAYERS: (c) => mpGame(c, (s) => ({ mutedPlayerIds: s.muted[c.userId] || [] })),
    GAME_SYNC_STATISTICS: (c) => {
        c.logger.debug("GAME_SYNC_STATISTICS %s %s %s", c.userId, c.req.CONTEXT_NAME, c.req.REASON);
        return {};
    },
    GAME_WON: mpWon,
    // Not filtered by mute (client filters locally, MutePlayersController). ASSUMPTION.
    CHAT_EMOJI: (c) => {
        const ids: string[] = ((c.req.PLAYER_IDS && c.req.PLAYER_IDS.playerIds) || []).filter((u: string) => u !== c.userId);
        if (!ids.length) return {};
        const me = c.nk.usersGetId([c.userId])[0];
        const prof = storeGet(c.nk, "profile", "main", c.userId);
        const who = (prof && prof.displayName) || (me && (me.displayName || me.username)) || "";
        for (const u of mpRealUsers(c.nk, ids)) gsPushScript(c.nk, u, "CHAT_EMOJI", { emojiId: c.req.EMOJI_ID, who: who }, false);
        return {};
    },
};
