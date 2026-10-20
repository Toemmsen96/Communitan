// Matchmaking + challenge creation + session discovery. Contract: docs/protocol/multiplayer.md B1, C.1, C.3
// Matchmaker: plain Nakama relayed matches (status.ts has a matched hook for counts only, returns nothing); the client joins with the token, then calls
// MatchmakingRequest with matchId; match id doubles as challengeId and chat room id.

function mpUniq(a: string[]): string[] {
    const r: string[] = [];
    for (const x of a) if (x && r.indexOf(x) < 0) r.push(x);
    return r;
}

const MP_MM_REPLAY_MS = 120000; // ASSUMPTION: all participants call MatchmakingRequest within seconds of the matchmaker match

function mpMatchmaking(c: GsContext): any {
    const r = c.req;
    if (r.action === "cancel" || !r.matchId) return {};
    rngRequireCaps(c);
    const matchId: string = r.matchId;
    const ptr = mpUserGet(c.nk, c.userId);
    if (ptr.challengeId && ptr.challengeId !== matchId) mpExitSession(c, ptr.challengeId); // stale game must not answer the handshake poll
    let created = false;
    // Dedupe: first MatchmakingRequest for a matchId fixes seat order (its playerIds) + gameInfo (its scenario pick).
    const m = mpMutate<any>(c.nk, MP_MATCHES, matchId, (cur) => {
        if (cur) return null;
        created = true;
        const ids = mpUniq((r.playerIds || []).concat([c.userId]));
        const gi: any = {};
        const src = (r.participantData && r.participantData.gameInformation) || {};
        for (const k in src) gi[k] = src[k];
        gi.sortedPlayerIds = ids;
        gi.challengeId = matchId;
        return { matchId: matchId, ids: ids, gameInfo: gi, shortCode: r.matchShortCode || "", created: Date.now() };
    })!;
    // MatchmakingRequest is a durable request: the client persists it and replays it after a restart. A replay for an
    // old match must not push MatchFoundMessage again (a client waiting for a new match would take it).
    if (!created && Date.now() - (m.created || 0) > MP_MM_REPLAY_MS) return {};
    const msg = {
        "@class": ".ScriptMessage", extCode: "MatchFoundMessage", matchId: matchId, matchShortCode: m.shortCode,
        participants: mpPlayerDetails(c, m.ids, m.ids), scriptData: m.gameInfo,
    };
    // First call notifies everybody; later calls re-notify only the caller (client unsubscribes after the first one).
    for (const u of created ? m.ids : [c.userId]) {
        const copy: any = {};
        for (const k in msg) copy[k] = (msg as any)[k];
        copy.messageId = c.nk.uuidv4();
        gsPush(c.nk, u, copy, false);
    }
    return {};
}

// Server RNG level: rngMode() (mp_rng.ts). "seeds" and "full" replace seed/diceSeed/colorSeed with server CSPRNG values.
// Every client incl. the creator reads the seeds back from GAME_GET_GAME_DETAILS_V3 / GAME_GET_GAMESTATE_AND_ACTIONS_V3
// (Common.Net/GameSetupState.cs:66-68, RejoinState.cs:39-41).
// 31-bit non-negative int from nk.uuidv4 (Go crypto/rand); the first 8 hex digits of a v4 uuid are all random.
function mpRngSeed(nk: nkruntime.Nakama): number {
    return parseInt(nk.uuidv4().substring(0, 8), 16) & 0x7fffffff;
}

function mpCreateChallenge(c: GsContext): any {
    const r = c.req;
    const sd = r.scriptData || {};
    const id: string = sd.challengeInstanceId || c.nk.uuidv4();
    const gi: any = sd.gameInfo || {};
    const humans = mpUniq([c.userId].concat(r.usersToChallenge || []));
    let seats: string[] = (gi.sortedPlayerIds || []).slice();
    if (!seats.length) seats = humans.slice();
    const spectator = gi.spectatorId && humans.indexOf(gi.spectatorId) >= 0 && seats.indexOf(gi.spectatorId) < 0 ? gi.spectatorId : undefined;
    for (const u of humans) if (u !== spectator && seats.indexOf(u) < 0) seats.push(u); // ASSUMPTION: unseated human gets the next seat
    const cli = [sd.seed | 0, sd.colorSeed | 0, sd.diceSeed === undefined ? -1 : sd.diceSeed | 0];
    rngRequireCaps(c);
    const rng = rngMode(c.ctx);
    const serverSeeds = rng !== "off";
    mpMutate<MpSession>(c.nk, MP_SESSIONS, id, (cur, fx) => {
        // durable retry of the same create (same client seeds) -> keep; a different/old session under the same id (lobby reuse) -> replace
        const curCli = cur && (cur.clientSeeds || [cur.seed, cur.colorSeed, cur.diceSeed]);
        if (cur && curCli && cur.state !== "COMPLETED" && curCli[0] === cli[0] && curCli[1] === cli[1] && curCli[2] === cli[2]) return null;
        const now = Date.now();
        const s: MpSession = {
            id: id, gen: c.nk.uuidv4(), state: "RUNNING", created: now, creatorId: c.userId, gameInfo: gi,
            seed: serverSeeds ? mpRngSeed(c.nk) : cli[0], colorSeed: serverSeeds ? mpRngSeed(c.nk) : cli[1], diceSeed: serverSeeds ? mpRngSeed(c.nk) : cli[2],
            clientSeeds: cli, rng: rng,
            seats: seats, humans: humans.filter((u) => u !== spectator), spectatorId: spectator, hostIdx: -1,
            nActions: 0, lastPlayed: {}, tt: {}, ctx: {}, recent: [], ready: [], startedIds: [], logicStarted: false, pres: {}, muted: {},
        };
        for (const u of s.humans) s.pres[u] = { seen: now, afk: 0 };
        mpElectHost(s);
        for (const u of humans) mpUserPut(fx, u, { challengeId: id });
        return s;
    });
    return gsRaw({ challengeInstanceId: id, scriptData: {} });
}

function mpCurrentSession(c: GsContext): any {
    const r = c.req;
    const ptr = mpUserGet(c.nk, c.userId);
    const hint: string = r.currentChallengeId || "";
    const out: any = {};
    if (ptr.kicked && (!hint || hint === ptr.kicked.challengeId)) {
        if (r.REMOVE_WAS_KICKED_FLAG == 1) {
            const fx = new MpFx();
            mpUserPut(fx, c.userId, { challengeId: ptr.challengeId });
            mpFlush(c.nk, fx);
        }
        return { currentChallengeId: ptr.kicked.challengeId, challengeState: "RUNNING", wasKickedFromChallengeId: ptr.kicked.challengeId, wasKickedReason: ptr.kicked.reason };
    }
    // ASSUMPTION: a hint (local match/lobby id) wins over the stored pointer; completed sessions are never reported
    // (handshake polls would otherwise abort on a previous game in the same lobby).
    const id = hint || ptr.challengeId;
    if (!id) return out;
    const s: MpSession | null = mpGet(c.nk, MP_SESSIONS, id);
    if (!s || s.state === "COMPLETED" || mpIsKicked(s, c.userId) || (s.humans.indexOf(c.userId) < 0 && s.spectatorId !== c.userId)) return out;
    const d = mpGameInfoFlat(s);
    d.currentChallengeId = s.id;
    d.challengeState = "RUNNING";
    d.playerDetails = mpPlayerDetails(c, s.seats, s.humans);
    return d;
}

const MP_MATCH_HANDLERS: GsHandlerTable = {
    MatchmakingRequest: mpMatchmaking,
    CreateChallengeRequest: mpCreateChallenge,
    GAME_GET_CURRENT_SESSION: mpCurrentSession,
    // dead in the client; answered from the pointer for completeness
    GAME_GET_CURRENT_CHALLENGE_ID: (c) => {
        const id = mpUserGet(c.nk, c.userId).challengeId;
        return id ? { challengeId: id, currentChallengeId: id } : {};
    },
};
