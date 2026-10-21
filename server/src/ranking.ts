// LEADERBOARD_*, standard leaderboard requests, SEASON_*, TOURNAMENT_* (feature disabled), ranking writes + level progress.
// Contract: docs/protocol/economy-ranking.md sec 3, 10-14.
// ELO/XP source of truth = collection mp_stats/main (written by mp_game GAME_WON; account.ts profileFlat reads it too).
// Nakama leaderboards are derived copies written by rankingRecordResult: score = elo*1000 (int), games in record metadata.
// Client-facing ELO values = elo*1e6 (Elo.ELO_LEADERBOARD_FACTOR). Leaderboards are created in InitModule (main.ts); season ones lazily.

const RK_BRACKETS = [1, 5, 25, 45, 85]; // PROD LEADERBOARD_GET_BRACKETS (capture 2026-10-21)
const RK_PLACEMENT = 5;      // ranked games before the client shows an ELO bracket (EloEntry.cs:73)
const RK_SCORE = 1000;       // leaderboard score = elo * RK_SCORE
const RK_CLIENT = 1000;      // score * RK_CLIENT = elo * 1e6
const RK_LB_PLAYER = "PLAYER_ELO_RANKING.EXPANSION.";
const RK_LB_GUILD = "GUILD_ELO_RANKING";
const RK_LB_SEASON = "SEASON_ELO_RANKING.";
const RK_LEVEL_BASE = 25;    // profiles start here (everything unlocked); xp to leave level L = 100 + 20*L
const RK_MAX_LEVEL = 100;
const RK_ERR_NO_LEADERBOARD = 36;
const RK_ERR_NOT_ENOUGH_COINS = 21;
const RK_ERR_UNAVAILABLE = 48;

interface RkResult {
    userId: string; gameId: string; expansion: string; ranked: boolean;
    elo: number; games: number; increase: number;   // absolute new ELO, ranked games in this expansion, ELO delta
    xpBefore: number; xpGain: number;
    seasonId?: string; seasonElo?: number; seasonGames?: number; seasonPrev?: { elo: number; games: number };
}

// ---- stats / level (single source: mp_stats) ----
function rkStats(nk: nkruntime.Nakama, userId: string): any {
    const st = storeGet(nk, "mp_stats", "main", userId);
    return st ? st : { elo: {}, eloPlacement: {}, xp: 0, played: 0, won: 0 };
}

function rkLevel(totalXp: number): { level: number; xp: number; next: number } {
    let l = RK_LEVEL_BASE;
    let x = Math.max(0, Math.floor(totalXp || 0));
    while (l < RK_MAX_LEVEL && x >= 100 + 20 * l) {
        x -= 100 + 20 * l;
        l++;
    }
    return { level: l, xp: x, next: 100 + 20 * l };
}

// ---- seasons ----
function rkSeasons(nk: nkruntime.Nakama, ctx?: nkruntime.Context): any[] {
    try {
        return dataLoad(ctx || ({} as nkruntime.Context), nk, "seasons.json").seasons || [];
    } catch (e) {
        return [];
    }
}

function rkSeasonState(s: any, now: number): string {
    const a = Date.parse(s.date_from);
    const b = Date.parse(s.date_to) + 86400000;
    return now < a ? "ISSUED" : now < b ? "RUNNING" : "COMPLETED";
}

// Season a ranked game counts for: explicit gameInfo.seasonId, else first running one for the expansion, else first running.
function rkSeasonFor(nk: nkruntime.Nakama, seasonId: string, exp: string, ctx?: nkruntime.Context): any {
    const run = rkSeasons(nk, ctx).filter((s) => rkSeasonState(s, Date.now()) === "RUNNING");
    return run.filter((s) => s.id === seasonId)[0] || run.filter((s) => s.expansion === exp)[0] || run[0] || null;
}

// ---- leaderboard plumbing ----
const RK_ENSURED: { [id: string]: boolean } = {};

function rkEnsure(nk: nkruntime.Nakama, id: string) {
    if (RK_ENSURED[id]) return;
    nk.leaderboardCreate(id, true, nkruntime.SortOrder.DESCENDING, nkruntime.Operator.SET, null, null, true); // idempotent
    RK_ENSURED[id] = true;
}

function rkKnown(c: GsContext, id: string): boolean {
    if (id === RK_LB_GUILD) return true;
    if (id.indexOf(RK_LB_PLAYER) === 0) return ACC_ELO_EXPANSIONS.indexOf(id.substring(RK_LB_PLAYER.length)) >= 0;
    if (id.indexOf(RK_LB_SEASON) === 0) return rkSeasons(c.nk, c.ctx).some((s) => RK_LB_SEASON + s.id === id);
    return false;
}

function rkBoard(c: GsContext, id: any): string {
    id = String(id || "");
    if (!rkKnown(c, id)) gsFail({ errorCode: RK_ERR_NO_LEADERBOARD });
    rkEnsure(c.nk, id);
    return id;
}

function rkGames(r: nkruntime.LeaderboardRecord): number {
    return ((r.metadata && r.metadata.games) | 0);
}

// Row with every key alias the client reads (LeaderboardEntry.cs: ELO/INCREASE, score/gamesPlayed, ELO/COUNT, LAST-ELO/SUM-COUNT).
function rkRow(r: nkruntime.LeaderboardRecord, rank?: number): any {
    const elo = r.score * RK_CLIENT;
    const g = rkGames(r);
    const fin = !!(r.metadata && r.metadata.finished);
    const d: any = { userId: r.ownerId, userName: r.username, rank: rank !== undefined ? rank : r.rank, ELO: elo, INCREASE: g, COUNT: g, score: elo, gamesPlayed: g, HASFINISHED: fin };
    if (r.leaderboardId === RK_LB_GUILD) {
        d.teamId = r.ownerId;
        d.teamName = r.username;
        d["LAST-ELO"] = elo;
        d["SUM-COUNT"] = g;
    }
    return d;
}

// Own-entry placeholder for players without a record (see LeaderboardsEntriesRequest): no userId = "not me" branch.
const RK_UNRANKED = { userId: "", userName: "", rank: 0, ELO: 0, INCREASE: 0, COUNT: 0, score: 0, gamesPlayed: 0, HASFINISHED: false };

function rkTotal(nk: nkruntime.Nakama, id: string): number {
    return nk.leaderboardRecordsList(id, undefined, 1).rankCount || 0;
}

function rkRecord(nk: nkruntime.Nakama, id: string, userId: string): nkruntime.LeaderboardRecord | null {
    const r = nk.leaderboardRecordsList(id, [userId], 1).ownerRecords || [];
    return r.length ? r[0] : null;
}

function rkPage(nk: nkruntime.Nakama, id: string, offset: number, count: number): { records: nkruntime.LeaderboardRecord[]; total: number } {
    count = Math.max(1, Math.min(count | 0 || 20, 1000));
    offset = Math.max(0, offset | 0);
    let cursor: string | undefined;
    if (offset > 0) {
        try { cursor = nk.leaderboardRecordsListCursorFromRank(id, offset + 1); } catch (e) { return { records: [], total: rkTotal(nk, id) }; }
    }
    const l = nk.leaderboardRecordsList(id, undefined, count, cursor);
    return { records: l.records || [], total: l.rankCount || 0 };
}

// Records of me + accepted friends + guild members ("OnlyFriendsAndGuildMembers"), with their GLOBAL ranks: the client
// computes bracket icons from rank and the response's entryCount (LeaderboardScreen.cs:82), so callers send rkTotal.
function rkFriendRows(c: GsContext, id: string): any[] {
    const owners = [c.userId].concat(socIds(socFriends(c, c.userId)[0]));
    const g = socMyGuild(c.nk, c.userId);
    if (g) for (const m of socGuildMembers(c.nk, g.group.id)) if (m.state <= 2) owners.push(m.uid);
    const uniq = owners.filter((u, i) => owners.indexOf(u) === i).slice(0, 100);
    const recs = (c.nk.leaderboardRecordsList(id, uniq, 1).ownerRecords || []).slice();
    recs.sort((a, b) => a.rank - b.rank);
    return recs.map((r) => rkRow(r));
}

// Best-ranked players on board `id` whose name starts with `name` (case-insensitive), or an exact user id
// (ProfileStatisticsScreen.cs:129 passes playerDetails.Id as PLAYERNAME). Ranked in SQL so the top players aren't cut off.
function rkFindIds(nk: nkruntime.Nakama, id: string, name: string, limit: number): string[] {
    const raw = String(name || "").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return [raw.toLowerCase()];
    const q = raw.replace(/[\\%_]/g, "\\$&");
    if (!q) return [];
    const rows = nk.sqlQuery(
        "SELECT r.owner_id::text AS uid FROM leaderboard_record r JOIN storage n ON n.collection = 'names' AND n.value->>'userId' = r.owner_id::text " +
        "WHERE r.leaderboard_id = $1 AND n.value->>'name' ILIKE $2 ORDER BY r.score DESC, r.subscore DESC LIMIT $3", [id, q + "%", limit]);
    return rows.map((r: any) => r.uid).filter((u: string) => !!u);
}

// Rows (by global rank) of the named players that have a record.
function rkNameRows(nk: nkruntime.Nakama, id: string, name: string, limit = 20): { rows: any[]; total: number } {
    const ids = rkFindIds(nk, id, name, Math.max(1, Math.min(limit, 100)));
    if (!ids.length) return { rows: [], total: rkTotal(nk, id) };
    const l = nk.leaderboardRecordsList(id, ids, 1);
    const recs = (l.ownerRecords || []).slice().sort((a, b) => a.rank - b.rank);
    return { rows: recs.map((r) => rkRow(r)), total: l.rankCount || 0 };
}

function rkName(nk: nkruntime.Nakama, userId: string): string {
    const p = storeGet(nk, "profile", "main", userId);
    if (p && p.displayName) return p.displayName;
    const u = nk.usersGetId([userId]);
    return u.length ? (u[0].displayName || u[0].username) : "";
}

// Records carry the display name of their last write: rename them too (account.ts ChangeUserDetailsRequest). Plain SQL:
// leaderboardRecordWrite skips records whose score doesn't change, and the rank cache doesn't hold names.
function rankingRename(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, name: string) {
    try {
        nk.sqlExec("UPDATE leaderboard_record SET username = $1 WHERE owner_id = $2", [name, userId]);
    } catch (e) {
        logger.warn("rankingRename %s: %s", userId, String(e));
    }
}

// ---- profile statistics (Common.Net.PlayerStatistics/Statistics.cs, UiRework/ProfileStatisticsScreen.cs) ----
// mp_stats counters per expansion/map: games, maps, winsMp, winsSp. Multiplayer: mp_game mpEloRows; singleplayer: rankingRecordSolo.
const RK_MAX_MAPS = 200;

function rkCount(st: any, field: string, key: string) {
    st[field] = st[field] || {};
    if (!key || (!(key in st[field]) && Object.keys(st[field]).length >= RK_MAX_MAPS)) return;
    st[field][key] = (st[field][key] | 0) + 1;
}

// One finished game into the counters; caller writes st.
function rankingCountGame(st: any, exp: string, map: string, won: boolean, solo: boolean) {
    rkCount(st, "games", exp);
    rkCount(st, "maps", String(map || "").slice(0, 64));
    if (won) rkCount(st, solo ? "winsSp" : "winsMp", exp);
}

// scriptData.statistics: lists of {keys:{EXPANSION|MAP[, SINGLEPLAYER]}, SUM-COUNT|COUNT-WON}. Missing block = empty screen.
function rkStatistics(st: any): any {
    const list = (o: any, key: string, val: string, extra: any) => Object.keys(o || {}).map((k) => {
        const keys: any = { [key]: k };
        for (const x in extra) keys[x] = extra[x];
        return { keys: keys, [val]: o[k] };
    });
    return {
        gamesWon: list(st.winsSp, "EXPANSION", "SUM-COUNT", { SINGLEPLAYER: 1 }).concat(list(st.winsMp, "EXPANSION", "SUM-COUNT", { SINGLEPLAYER: 0 })),
        mostPlayedExpansions: list(st.games, "EXPANSION", "COUNT-WON", {}),
        mostPlayedMaps: list(st.maps, "MAP", "COUNT-WON", {}),
    };
}

// Singleplayer GAME_WON (no session, SINGLEPLAYER 1): count it. Durable retries repeat the requestId -> counted once.
function rankingRecordSolo(c: GsContext) {
    const exp = String(c.req.EXPANSION || "");
    if (ACC_EXPANSION_NAMES.indexOf(exp) < 0) return;
    const rid = String(c.req.requestId || "");
    for (let i = 0; i < 3; i++) {
        const o = c.nk.storageRead([{ collection: MP_STATS, key: "main", userId: c.userId }])[0];
        const st = o ? JSON.parse(JSON.stringify(o.value)) : { elo: {}, eloPlacement: {}, xp: 0, played: 0, won: 0 };
        const done: string[] = st.soloDone || [];
        if (rid && done.indexOf(rid) >= 0) return;
        rankingCountGame(st, exp, c.req.MAP, c.req.WON == 1, true);
        st.soloDone = done.concat(rid ? [rid] : []).slice(-20);
        try {
            c.nk.storageWrite([mpObj(MP_STATS, "main", st, o ? o.version : "*", c.userId)]);
            return;
        } catch (e) { /* concurrent write: re-read */ }
    }
    c.logger.warn("rankingRecordSolo %s: gave up after write conflicts", c.userId);
}

// ---- recording (called from mp_game GAME_WON) ----
function rkGuild(nk: nkruntime.Nakama, logger: nkruntime.Logger, r: RkResult) {
    const g = socMyGuild(nk, r.userId);
    if (!g) return;
    const md: any = JSON.parse(JSON.stringify(g.group.metadata || {}));
    const key = r.gameId + ":" + r.userId;
    const done: string[] = md.done || [];
    if (done.indexOf(key) >= 0) return; // GAME_WON retry
    md.elo = (md.elo !== undefined ? md.elo : 1000) + r.increase;
    md.count = (md.count | 0) + 1;
    md.done = done.concat([key]).slice(-50);
    nk.groupUpdate(g.group.id, null, null, null, null, null, null, null, md);
    rkEnsure(nk, RK_LB_GUILD);
    nk.leaderboardRecordWrite(RK_LB_GUILD, g.group.id, g.group.name, Math.round(md.elo * RK_SCORE), 0, { games: md.count }, nkruntime.OverrideOperator.SET);
}

// Writes leaderboards (player ELO, guild ELO, season ELO) and pushes LEVEL_PROGRESS when XP crosses a level.
// Does NOT touch mp_stats (caller owns it). Absolute values -> safe to repeat. `push` defaults to a persistent notification.
function rankingRecordResult(nk: nkruntime.Nakama, logger: nkruntime.Logger, results: RkResult[], push?: (userId: string, ext: string, data: any) => void) {
    for (const r of results) {
        try {
            const name = rkName(nk, r.userId);
            if (r.ranked && ACC_ELO_EXPANSIONS.indexOf(r.expansion) >= 0) {
                const id = RK_LB_PLAYER + r.expansion;
                rkEnsure(nk, id);
                nk.leaderboardRecordWrite(id, r.userId, name, Math.round(r.elo * RK_SCORE), 0, { games: r.games }, nkruntime.OverrideOperator.SET);
                rkGuild(nk, logger, r);
            }
            if (r.seasonId) {
                const id = RK_LB_SEASON + r.seasonId;
                rkEnsure(nk, id);
                const cur = rkRecord(nk, id, r.userId);
                const md: any = { games: r.seasonGames, finished: !!(cur && cur.metadata && cur.metadata.finished), last: r.gameId, prevElo: r.seasonPrev!.elo, prevGames: r.seasonPrev!.games };
                nk.leaderboardRecordWrite(id, r.userId, name, Math.round(r.seasonElo! * RK_SCORE), 0, md, nkruntime.OverrideOperator.SET);
            }
            const a = rkLevel(r.xpBefore).level;
            const b = rkLevel(r.xpBefore + r.xpGain).level;
            if (b > a) {
                const send = push || ((u: string, ext: string, d: any) => gsPushScript(nk, u, ext, d));
                send(r.userId, "LEVEL_PROGRESS", { level: b, tickets: 0 });
            }
        } catch (e) {
            logger.error("rankingRecordResult %s: %s", r.userId, String(e));
        }
    }
}

// mp_game adapter: GAME_WON rows (+ session) -> RkResult[], adds season fields to the rows. Must run BEFORE mp_stats is written (reads pre-state xp).
function rankingRecordGame(nk: nkruntime.Nakama, logger: nkruntime.Logger, s: MpSession, reqExp: string, rows: any[], fx: MpFx) {
    const exp: string = reqExp || ((s.gameInfo.expansions || [])[0]) || "CatanBaseGame";
    const mt = s.gameInfo.matchType;
    const ranked = mt === "AUTO_MATCH" || mt === "QUICK_MATCH";
    const stats = mpStatsGet(nk, s.humans);
    const out: RkResult[] = [];
    for (const row of rows) {
        if (s.humans.indexOf(row.playerId) < 0) continue;
        const st = stats[row.playerId];
        const r: RkResult = {
            userId: row.playerId, gameId: s.id, expansion: exp, ranked: ranked, elo: row.eloBefore + row.increaseElo, games: row.placementMatchesPlayed,
            increase: row.increaseElo, xpBefore: (st && st.xp) || 0, xpGain: row.xpEarned || 0,
        };
        const sn = ranked && s.gameInfo.isSeason ? rkSeasonFor(nk, s.gameInfo.seasonId, exp) : null;
        if (sn) {
            const id = RK_LB_SEASON + sn.id;
            rkEnsure(nk, id);
            const cur = rkRecord(nk, id, row.playerId);
            if (cur) { // participants only; retry of the same game reuses the pre-game values stored in the record
                const again = cur.metadata && cur.metadata.last === s.id;
                const prev = again ? { elo: cur.metadata.prevElo, games: cur.metadata.prevGames } : { elo: cur.score / RK_SCORE, games: rkGames(cur) };
                r.seasonId = sn.id;
                r.seasonPrev = prev;
                r.seasonElo = prev.elo + row.increaseElo;
                r.seasonGames = prev.games + 1;
                row.isSeasonParticipant = true;
                row.seasonEloBefore = prev.elo;
                row.increaseSeasonElo = row.increaseElo;
                row.seasonPlacementMatches = Math.min(r.seasonGames!, sn.placementMatches | 0);
            }
        }
        out.push(r);
    }
    rankingRecordResult(nk, logger, out, (u, ext, d) => fx.script([u], ext, d));
}

// ---- seasons API ----
function rkSeasonById(c: GsContext, id: any): any {
    const list = rkSeasons(c.nk, c.ctx);
    const s = id ? list.filter((x) => x.id === String(id))[0] : list.filter((x) => rkSeasonState(x, Date.now()) === "RUNNING")[0];
    if (!s) gsFail({ errorCode: RK_ERR_UNAVAILABLE });
    return s;
}

function rkReward(r: any): any {
    const d: any = { scrolls: 0, suns: 0, products: [], productIds: [], featureIds: [] };
    for (const k in r || {}) d[k] = r[k];
    return d;
}

function rkSeasonObj(c: GsContext, s: any): any {
    const id = RK_LB_SEASON + s.id;
    rkEnsure(c.nk, id);
    const mine = rkRecord(c.nk, id, c.userId);
    const d: any = {
        id: s.id, name: s.name, description: s.description || "", date_from: s.date_from, date_to: s.date_to, state: rkSeasonState(s, Date.now()), expansion: s.expansion || "CatanBaseGame",
        published: true, placementMatches: s.placementMatches | 0, participationFee: s.participationFee | 0, participationFeeGold: s.participationFeeGold | 0,
        isLocalPlayerParticipant: !!mine, leaderboardCount: rkTotal(c.nk, id), reward1: rkReward(s.reward1), reward2: rkReward(s.reward2), reward3: rkReward(s.reward3),
    };
    if (s.seasonGameModeData) d.seasonGameModeData = s.seasonGameModeData;
    if (mine) {
        d.myRank = rkRow(mine);
        d.myPlacementMatches = rkGames(mine);
    }
    return d;
}

function rkSeasonJoin(c: GsContext) {
    const s = rkSeasonById(c, c.req.SEASON_ID);
    if (rkSeasonState(s, Date.now()) !== "RUNNING") gsFail({ errorCode: RK_ERR_UNAVAILABLE });
    const id = RK_LB_SEASON + s.id;
    rkEnsure(c.nk, id);
    if (rkRecord(c.nk, id, c.userId)) return {}; // durable retry / already joined
    const p = profileGet(c);
    if (c.req.PAYMENT == 2) {
        const fee = s.participationFee | 0;
        if (p.currency2 < fee) gsFail({ errorCode: RK_ERR_NOT_ENOUGH_COINS });
        p.currency2 -= fee;
    } else {
        const fee = s.participationFeeGold | 0;
        if (p.currency1 < fee) gsFail({ errorCode: RK_ERR_NOT_ENOUGH_COINS });
        p.currency1 -= fee;
    }
    profileSave(c, p);
    c.nk.leaderboardRecordWrite(id, c.userId, rkName(c.nk, c.userId), 1000 * RK_SCORE, 0, { games: 0, finished: false }, nkruntime.OverrideOperator.SET);
    return {};
}

function rkSeasonFinished(c: GsContext): any {
    const s = rkSeasonById(c, c.req.SEASON_ID);
    const id = RK_LB_SEASON + s.id;
    rkEnsure(c.nk, id);
    const mine = rkRecord(c.nk, id, c.userId);
    if (!mine || rkSeasonState(s, Date.now()) !== "COMPLETED") return {};
    const games = rkGames(mine);
    if (games < (s.placementMatches | 0)) return { seasonPlacementMatches: games };
    const total = rkTotal(c.nk, id);
    const pct = (mine.rank - 1) * 100 / Math.max(total, 1);
    const cat = pct < ((s.reward1 || {}).percentage || 0) ? 0 : pct < ((s.reward2 || {}).percentage || 0) ? 1 : 2;
    const rw = rkReward(s["reward" + (cat + 1)]);
    if (!(mine.metadata && mine.metadata.finished)) { // first time: mark + grant scrolls
        const md: any = JSON.parse(JSON.stringify(mine.metadata || {}));
        md.finished = true;
        c.nk.leaderboardRecordWrite(id, c.userId, mine.username, mine.score, mine.subscore, md, nkruntime.OverrideOperator.SET);
        const p = profileGet(c);
        p.currency2 += rw.scrolls | 0;
        profileSave(c, p);
    }
    const out: any = { seasonRank: mine.rank, seasonRankCount: total, seasonElo: Math.round(mine.score / RK_SCORE), seasonRankCategory: cat };
    for (const k in rw) out[k] = rw[k];
    return out;
}

function rkSeasonBoard(c: GsContext): string {
    return rkBoard(c, RK_LB_SEASON + rkSeasonById(c, c.req.SEASON_ID).id);
}

const RANKING_HANDLERS: GsHandlerTable = {
    LEADERBOARD_GET_BRACKETS: () => ({ brackets: RK_BRACKETS }),
    // rankPercentage = floor(rank*100/total), the client's own list formula (LeaderboardBrackets.GetBracketIdx(rank, count);
    // integer thresholds -> floor keeps the bracket), so profile/result badges match the leaderboard icons.
    // Only expansions past placement: a missing entry makes the result screen show "x/5 placement" (ResultStatisticsPlayerEntry.cs:384).
    LEADERBOARD_GET_BRACKETS_BY_ID: (c) => {
        const id = String(c.req.PLAYER_ID || c.userId);
        const out: any[] = [];
        for (const e of ACC_ELO_EXPANSIONS) {
            const lb = RK_LB_PLAYER + e;
            rkEnsure(c.nk, lb);
            const l = c.nk.leaderboardRecordsList(lb, [id], 1);
            const r = (l.ownerRecords || [])[0];
            if (r && rkGames(r) >= RK_PLACEMENT) out.push({ expansion: e, rankPercentage: Math.floor(r.rank * 100 / Math.max(l.rankCount || 1, 1)) });
        }
        return { brackets: RK_BRACKETS, rankPercentages: out };
    },
    LEADERBOARD_FIND_RANKS_FOR_PLAYERNAMES: (c) => {
        const r = rkNameRows(c.nk, rkBoard(c, RK_LB_PLAYER + c.req.EXPANSION), String(c.req.PLAYERNAME || ""));
        return { leaderboard: r.rows, entryCount: r.total };
    },
    LEADERBOARD_FIND_RANKS_FOR_FRIENDS_LEADERBOARD: (c) => {
        const id = rkBoard(c, RK_LB_PLAYER + c.req.EXPANSION);
        return { leaderboard: rkFriendRows(c, id), entryCount: rkTotal(c.nk, id) };
    },
    LEADERBOARD_GAME_WON: () => ({}), LEADERBOARD_GAME_LOST: () => ({}), LEADERBOARD_SET_ELO: () => ({}), LEADERBOARD_SET_GUILD_ELO: () => ({}), LEADERBOARD_SET_SEASON_ELO: () => ({}), // dead from client

    LeaderboardDataRequest: (c) => {
        const id = rkBoard(c, c.req.leaderboardShortCode);
        // `social` is ignored: LeaderboardScreen never resets _filterFriendsOnly (Toggle_OnlyFriendsAndGuildMembers), so after
        // unticking "friends" every reload/scroll still says social:true. The friends view itself comes from
        // LEADERBOARD_FIND_RANKS_FOR_FRIENDS_LEADERBOARD; cost: an expansion switch while it's ticked shows everyone.
        const p = rkPage(c.nk, id, c.req.offset, c.req.entryCount);
        return gsRaw({ data: p.records.map((r) => rkRow(r)), scriptData: { entryCount: p.total } });
    },
    AroundMeLeaderboardRequest: (c) => {
        const id = rkBoard(c, c.req.leaderboardShortCode);
        let recs: nkruntime.LeaderboardRecord[] = [];
        try { recs = c.nk.leaderboardRecordsHaystack(id, c.userId, Math.max(1, Math.min(c.req.entryCount | 0 || 10, 100)), "", 0).records || []; } catch (e) { /* no record yet */ }
        return gsRaw({ data: recs.map((r) => rkRow(r)), scriptData: { entryCount: rkTotal(c.nk, id) } });
    },
    // Own entry of the leaderboard screen. Must never be empty or an error for player boards: the client then dereferences a
    // null entry (LeaderboardScreen.cs:129) and the list never renders. Unranked = placeholder without userId (PROD sends
    // some other player's row) -> client shows the local player unranked. Other unknown boards (tournaments) -> [].
    LeaderboardsEntriesRequest: (c) => {
        const body: any = {};
        let n = 0;
        for (const code of c.req.leaderboards || []) {
            const id = String(code || "");
            const player = id.indexOf(RK_LB_PLAYER) === 0;
            if (!rkKnown(c, id)) {
                body[id] = player ? [RK_UNRANKED] : [];
                continue;
            }
            rkEnsure(c.nk, id);
            const rec = rkRecord(c.nk, id, String(c.req.player || c.userId));
            body[id] = rec ? [rkRow(rec)] : player ? [RK_UNRANKED] : [];
            if (!n) n = rkTotal(c.nk, id);
        }
        body.scriptData = { entryCount: n };
        return gsRaw(body);
    },
    GetLeaderboardEntriesRequest: () => ({ rank: -1 }), // tournament rank, dead

    SEASON_GET_SEASONS_DETAILS: (c) => ({ seasons: rkSeasons(c.nk, c.ctx).map((s) => rkSeasonObj(c, s)) }),
    SEASON_JOIN: rkSeasonJoin,
    SEASON_PLAYER_HAS_FINISHED: rkSeasonFinished,
    SEASON_GET_LEADERBOARD: (c) => {
        const p = rkPage(c.nk, rkSeasonBoard(c), c.req.OFFSET, c.req.COUNT);
        return { leaderboard: p.records.map((r) => rkRow(r)), leaderboardCount: p.total };
    },
    SEASON_GET_LEADERBOARD_FOR_PLAYERNAME: (c) => {
        const r = rkNameRows(c.nk, rkSeasonBoard(c), String(c.req.PLAYERNAME || ""), c.req.ENTRY_COUNT | 0 || 20);
        return { leaderboard: r.rows, leaderboardCount: r.total };
    },
    SEASON_GET_PARTICIPANTS: (c) => {
        const p = rkPage(c.nk, rkSeasonBoard(c), c.req.OFFSET, c.req.COUNT);
        return { participants: socPlayers(c, p.records.map((r) => r.ownerId)) };
    },
    SEASON_GET_PARTICIPANTS_WITH_PLAYERNAME: (c) => {
        const r = rkNameRows(c.nk, rkSeasonBoard(c), String(c.req.PLAYERNAME || ""), c.req.ENTRIES_COUNT | 0 || 20);
        return { participants: socPlayers(c, r.rows.map((x) => x.userId)) };
    },

    // Tournaments: feature disabled (isFeatureEnabled false) -> nothing below is reachable from the UI.
    TOURNAMENT_GET_CONFIG: () => ({ tournamentConfig: { isFeatureEnabled: false } }),
    TOURNAMENT_GET_LIST: () => ({ tournaments: [] }),
    TOURNAMENT_GET_MY_LIST: () => ({ tournaments: [], myCreatedTournaments: [], playersStates: [] }),
    TOURNAMENT_GET_PARTICIPANTS: () => ({ participants: [], acceptedIds: [] }),
    TOURNAMENT_GET_LEADERBOARD_FOR_PLAYERNAME: () => ({ data: [] }),
    TOURNAMENT_GET_GAME_RESULTS: () => ({ results: [] }),
    TOURNAMENT_PLAYER_UPDATE: () => ({}),
    TOURNAMENT_SET_RANKED_VALUE_FOR_PLAYER: () => ({}),
    TOURNAMENT_CREATE: () => gsFail({ errorCode: RK_ERR_UNAVAILABLE }),
    TOURNAMENT_JOIN: () => gsFail({ errorCode: RK_ERR_UNAVAILABLE }),
    TOURNAMENT_ACCEPT: () => gsFail({ errorCode: RK_ERR_UNAVAILABLE }),
    TOURNAMENT_REMOVE: () => gsFail({ errorCode: RK_ERR_UNAVAILABLE }),
    TOURNAMENT_QUIT: () => gsFail({ errorCode: RK_ERR_UNAVAILABLE }),
};
