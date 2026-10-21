// L3 anti-cheat, server-side rules: env CATAN_SERVER_RULES=off|audit|enforce, CATAN_REFEREE_URL (e.g. http://referee:8790).
// Design + verdict format: docs/design/level3-referee.md. The referee (referee/, .NET) replays the finished match with the
// game's own rules code. M1 = post-game: GAME_WON (mpWon, mp_game.ts) asks the referee before ranking/ELO.
//   audit:   verdict stored ("l3_verdicts"/<challengeId>, system-owned) + logged; result unchanged (client WIN_LOSE)
//   enforce: + ranks/ELO from the referee; a cheater (invalid action) is ranked last (a loss for ELO), "l3_cheats"/<challengeId>
//            stored for that user, session kick reason INVALID_GAME_DATA (pointer -> menu "you were kicked"). No mid-game kick (M2).
// Unreachable referee, timeout, unsupported scenario or desync -> unchanged behaviour (logged; audit record keeps the reason).
// The sender of every action is stored next to the blob ("s" in the action chunk) so a forged action is charged to its
// sender (AI seats are played by the host, turn timer actions by another client).

const L3_VERDICTS = "l3_verdicts";
const L3_CHEATS = "l3_cheats";
const L3_TIMEOUT_MS = 15000;
const L3_KICK_REASON = "INVALID_GAME_DATA";

function refMode(ctx: nkruntime.Context): string {
    const m = String((ctx.env && ctx.env["CATAN_SERVER_RULES"]) || "off").trim().toLowerCase();
    return m === "audit" || m === "enforce" ? m : "off";
}

function refUrl(ctx: nkruntime.Context): string {
    return String((ctx.env && ctx.env["CATAN_REFEREE_URL"]) || "").trim().replace(/\/+$/, "");
}

// Startup log (main.ts InitModule).
function refLogMode(ctx: nkruntime.Context, logger: nkruntime.Logger) {
    const m = refMode(ctx);
    if (m !== "off" && !refUrl(ctx)) logger.warn("CATAN_SERVER_RULES=%s without CATAN_REFEREE_URL: no game is judged", m);
    logger.info("server rules: %s%s", m, m !== "off" ? " (referee " + (refUrl(ctx) || "-") + ")" : "");
}

interface RefVerdict {
    supported?: boolean; ok?: boolean; finished?: boolean; winners?: string[]; reason?: string; error?: string;
    ranks?: { playerId: string; seat: number; vp: number; rank: number }[];
    invalid?: { uid: number; seat: number; playerId: string; senderId?: string; actionId: string; reason: string };
    desync?: { uid: number; result: string };
    stats?: any;
}
interface RefRecord { challengeId: string; gen: string; mode: string; at: number; verdict: RefVerdict; cheater?: string; claimed?: { [id: string]: number } }

// Who is charged for an invalid action: its sender if known, else the seat's owner.
function refCheater(v: RefVerdict | null): string {
    return (v && v.supported && v.invalid && (v.invalid.senderId || v.invalid.playerId)) || "";
}

// Asks the referee about a finished session (outside any storage mutation: slow HTTP). Reuses a stored verdict of the
// same session generation (several GAME_WON senders, durable retries). Returns null when rules are off / nothing to judge.
function refJudge(c: GsContext, challengeId: string): RefRecord | null {
    const mode = refMode(c.ctx);
    if (mode === "off") return null;
    const s: MpSession | null = mpGet(c.nk, MP_SESSIONS, challengeId);
    if (!s || s.state === "COMPLETED") return null;
    const old = storeGet(c.nk, L3_VERDICTS, challengeId, STORE_SYSTEM_USER) as RefRecord | null;
    if (old && old.gen === s.gen && old.verdict && !old.verdict.error) return old;
    const rec: RefRecord = { challengeId: challengeId, gen: s.gen, mode: mode, at: Date.now(), verdict: {} };
    const url = refUrl(c.ctx);
    if (!url) {
        rec.verdict = { error: "CATAN_REFEREE_URL not set" };
    } else {
        const acts = mpActions(c, s);
        const body = {
            session: { id: s.id, gen: s.gen, rng: s.rng || "off", seed: s.seed, diceSeed: s.diceSeed, colorSeed: s.colorSeed, gameInfo: s.gameInfo, seats: s.seats, humans: s.humans },
            actions: acts.a.map((a, i) => {
                const o: any = { a: a };
                if (acts.r[i]) o.w = acts.r[i]!.w;
                if (acts.by[i]) o.by = acts.by[i];
                return o;
            }),
        };
        try {
            const res = c.nk.httpRequest(url + "/v1/replay", "post", { "Content-Type": "application/json" }, JSON.stringify(body), L3_TIMEOUT_MS);
            const v = JSON.parse(res.body || "{}");
            rec.verdict = res.code === 200 ? v : { error: "HTTP " + res.code + (v && v.error ? ": " + v.error : "") };
        } catch (e) {
            rec.verdict = { error: "referee unreachable: " + String(e) };
        }
    }
    const v = rec.verdict;
    // A result claimed for a game that is not over under the rules: the replay applied every stored action cleanly
    // (desync uid -1 = NotFinished) and saw no Base_WinGame. The claimer's report is false (e.g. a client that built for
    // free and counted its own points). Not when other humans left/were kicked (the game may legitimately end differently).
    if (v.supported && !v.error && !v.invalid && v.desync && v.desync.uid === -1 && s.humans.every((u) => u === c.userId || !mpIsKicked(s, u))) {
        v.invalid = { uid: -1, seat: s.seats.indexOf(c.userId), playerId: c.userId, senderId: c.userId, actionId: "GAME_WON",
            reason: "claimed a result, but the game is not over under the rules (" + v.desync.result + ")" };
        v.ok = false;
    }
    rec.cheater = refCheater(v) || undefined;
    const cl = refClaimed(c);
    if (Object.keys(cl).length) rec.claimed = cl;
    if (v.error) c.logger.warn("referee: %s %s -> %s (result unchanged)", mode, challengeId, v.error);
    else if (!v.supported) c.logger.info("referee: %s %s not supported (%s), result unchanged", mode, challengeId, v.reason || "?");
    else if (v.invalid) c.logger.warn("referee: %s %s INVALID action uid=%d %s seat=%d sender=%s: %s", mode, challengeId, v.invalid.uid, v.invalid.actionId, v.invalid.seat, v.invalid.senderId || "-", v.invalid.reason);
    else if (v.desync) c.logger.warn("referee: %s %s desync at uid=%d: %s (result unchanged, not cheating)", mode, challengeId, v.desync.uid, v.desync.result);
    else {
        const forged = (v.ranks || []).some((x) => cl[x.playerId] !== undefined && cl[x.playerId] !== x.rank);
        if (forged) c.logger.warn("referee: %s %s claimed ranks %s differ from the replay %s", mode, challengeId, JSON.stringify(cl), JSON.stringify((v.ranks || []).map((x) => [x.playerId, x.rank])));
        else c.logger.info("referee: %s %s ok (%d actions, %d ms)", mode, challengeId, (v.stats && v.stats.actions) || 0, (v.stats && v.stats.ms) || 0);
    }
    try {
        c.nk.storageWrite([{ collection: L3_VERDICTS, key: challengeId, userId: STORE_SYSTEM_USER, value: rec, permissionRead: 0, permissionWrite: 0 }]);
    } catch (e) {
        c.logger.warn("referee: verdict not stored for %s: %s", challengeId, String(e));
    }
    return rec;
}

// Ranks the client claimed (GAME_WON WIN_LOSE), for the audit record.
function refClaimed(c: GsContext): { [id: string]: number } {
    const out: { [id: string]: number } = {};
    for (const e of (c.req.WIN_LOSE && c.req.WIN_LOSE.win_lose) || []) if (e && e.playerId && e.rank !== undefined) out[e.playerId] = e.rank | 0;
    return out;
}

// enforce: rank adjustment for mpEloRows (undefined = keep the client's WIN_LOSE). ok -> the referee's ranks;
// invalid -> the client's order for everyone else, the cheater last. Desync/unsupported/error -> unchanged.
function refRanks(c: GsContext, s: MpSession, rec: RefRecord | null): ((rank: { [id: string]: number }) => void) | undefined {
    if (!rec || rec.gen !== s.gen || refMode(c.ctx) !== "enforce") return undefined;
    const v = rec.verdict;
    if (!v.supported) return undefined;
    if (v.ok && v.finished && v.ranks && v.ranks.length === s.seats.length) {
        return (rank) => {
            for (const k of Object.keys(rank)) delete rank[k];
            for (const x of v.ranks!) rank[x.playerId] = x.rank;
        };
    }
    const cheater = refCheater(v);
    if (!cheater) return undefined;
    return (rank) => {
        const others = s.seats.filter((u) => u !== cheater && rank[u] !== undefined).sort((a, b) => rank[a] - rank[b]);
        let n = 0, prev = -1;
        for (const u of others) {
            if (rank[u] !== prev) n++;
            prev = rank[u];
            rank[u] = n;
        }
        if (s.seats.indexOf(cheater) >= 0) rank[cheater] = n + 1;
    };
}

// enforce, invalid verdict: cheat record + kick reason (game already over: no push, the seat keeps its result row).
// Returns the cheater's user id ("" = none) so mpWon leaves their "you were kicked" pointer in place.
function refPunish(c: GsContext, s: MpSession, rec: RefRecord | null, fx: MpFx): string {
    if (!rec || rec.gen !== s.gen || refMode(c.ctx) !== "enforce") return "";
    const cheater = refCheater(rec.verdict);
    if (!cheater || s.humans.indexOf(cheater) < 0 || !MP_UUID.test(cheater)) return "";
    const inv = rec.verdict.invalid!;
    fx.after.push(mpObj(L3_CHEATS, s.id, { challengeId: s.id, gen: s.gen, at: Date.now(), uid: inv.uid, seat: inv.seat, actionId: inv.actionId, reason: inv.reason }, undefined, cheater));
    const p = s.pres[cheater];
    if (p && !p.kicked) p.kicked = L3_KICK_REASON;
    mpUserPut(fx, cheater, { kicked: { challengeId: s.id, reason: L3_KICK_REASON } });
    c.logger.warn("referee: enforce %s: %s ranked last, kicked %s", s.id, cheater, L3_KICK_REASON);
    return cheater;
}

type RefInvalid = NonNullable<RefVerdict["invalid"]>;

// ---- M2 (inline, enforce only) ----
// Before a player's action is stored or relayed (mp_game.ts mpAction): replay the stored log + this action. If the referee
// flags exactly this action (uid), it is rejected (never stored or relayed, so no client applies it), the sender is kicked
// (INVALID_GAME_DATA, the others' clients turn the seat into AI) and the cheat is recorded. Fails open: referee error,
// unsupported scenario, or a log the referee can't get past (desync / older invalid action) -> accepted, and the session
// stops being checked inline (s.l3 = reason; the post-game replay still judges it). Cost: one full replay per action.
function refCheckAction(c: GsContext, s: MpSession, blob: string, rec: RngRec | undefined): RefInvalid | null {
    if (refMode(c.ctx) !== "enforce" || s.l3) return null;
    const url = refUrl(c.ctx);
    const b = rngB64Dec(blob);
    const parsed = b ? rngParse(b) : null;
    if (!url || !parsed) return null;
    const acts = mpActions(c, s);
    const actions: any[] = acts.a.map((a, i) => {
        const o: any = { a: a };
        if (acts.r[i]) o.w = acts.r[i]!.w;
        if (acts.by[i]) o.by = acts.by[i];
        return o;
    });
    const last: any = { a: blob, by: c.userId };
    if (rec) last.w = rec.w;
    actions.push(last);
    const body = {
        session: { id: s.id, gen: s.gen, rng: s.rng || "off", seed: s.seed, diceSeed: s.diceSeed, colorSeed: s.colorSeed, gameInfo: s.gameInfo, seats: s.seats, humans: s.humans },
        actions: actions,
    };
    let v: RefVerdict;
    try {
        const res = c.nk.httpRequest(url + "/v1/replay", "post", { "Content-Type": "application/json" }, JSON.stringify(body), L3_TIMEOUT_MS);
        const j = JSON.parse(res.body || "{}");
        v = res.code === 200 ? j : { error: "HTTP " + res.code + (j && j.error ? ": " + j.error : "") };
    } catch (e) {
        v = { error: "referee unreachable: " + String(e) };
    }
    // a running game always replays as "not finished" (desync uid -1): that is the normal mid-game verdict, not a desync
    if (v.desync && v.desync.uid === -1 && /^NotFinished/.test(v.desync.result || "")) delete v.desync;
    if (v.error) {
        s.l3 = "referee error: " + v.error; // once per session: a hung referee must not cost the timeout on every action
    } else if (!v.supported) {
        s.l3 = "unsupported: " + (v.reason || "?");
    } else if (v.invalid && v.invalid.uid === parsed.uid) {
        return v.invalid;
    } else if (v.invalid || v.desync) {
        s.l3 = v.invalid ? "earlier invalid action uid " + v.invalid.uid : "desync at uid " + v.desync!.uid + ": " + v.desync!.result;
    }
    if (s.l3) c.logger.warn("referee inline: %s stops checking this session (%s)", s.id, s.l3);
    return null;
}

// Rejected action: kick + cheat record now (the post-game replay will not see the action, it was never stored).
function refKickInline(c: GsContext, s: MpSession, inv: RefInvalid, fx: MpFx) {
    fx.after.push(mpObj(L3_CHEATS, s.id, { challengeId: s.id, gen: s.gen, at: Date.now(), uid: inv.uid, seat: inv.seat, actionId: inv.actionId, reason: inv.reason, inline: true }, undefined, c.userId));
    mpKick(s, c.userId, L3_KICK_REASON, false, fx);
    c.logger.warn("referee inline: enforce %s: action uid=%d %s seat=%d rejected, %s kicked %s: %s", s.id, inv.uid, inv.actionId, inv.seat, c.userId, L3_KICK_REASON, inv.reason);
}
