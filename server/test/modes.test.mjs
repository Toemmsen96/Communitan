// Custom game modes (docs/design/game-modes.md): npm run test:modes (server must be running, data/modes/robbers.json offered).
// Listing (status + COMMUNITAN_MODES), matchmaker pools per mode, Free Play delivery (MatchFound/details/state carry ccsMode +
// ccsModeDef, mode overrides the Free Play shuffle), caps gate "modes-1", full-RNG dice honour dice.fixedSum, unranked
// results, custom CreateChallenge validation, custom lobby modes (G2).
import { Client } from "@heroiclabs/nakama-js";
import { execSync } from "node:child_process";
import { HOSTNAME, PORT, SSL, SERVER_KEY, CONTAINER, BASE, HTTP_KEY, CONTAINER_CLI } from "./env.mjs";

const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const RUN = Date.now().toString(36);
const T0 = new Date();
let failures = 0, passes = 0, reqN = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.error("FAIL:", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sd = (r) => r.scriptData || {};
const errCode = (r) => (r.error ? r.error.errorCode : 0);
let RNG = "off";
const CAPS = () => (RNG === "full" ? "rng-full-1,modes-1" : "modes-1");
const NOMODE = () => (RNG === "full" ? "rng-full-1" : "");

// Thrift TBinary CommonGameActionState (same encoder as mp.test.mjs): roll = catanActionId 3 with asBaseRollDice.diceValues
const F = (t, id, val) => [t, (id >> 8) & 255, id & 255, ...val];
const I32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const STRUCT = (...fields) => [...fields.flat(), 0];
function rollBlob(uid, player, dice) {
    const cgas = [F(8, 1, I32(3)), F(8, 4, I32(1)), F(12, 1000, STRUCT(F(15, 1, [8, ...I32(dice.length), ...dice.flatMap(I32)])))];
    const top = [F(12, 1, STRUCT(F(8, 1, I32(3)))), F(8, 2, I32(player)), F(8, 3, I32(uid)), F(12, 10, STRUCT(...cgas)), F(8, 20, I32(player)), F(8, 23, I32(uid))];
    return Buffer.from(STRUCT(...top)).toString("base64");
}

const users = [];
async function mkUser(tag) {
    const session = await client.authenticateDevice(`modes-test-${tag}-${RUN}`, true, `md${tag}${RUN}`);
    const socket = client.createSocket(SSL, false);
    const u = { tag, session, socket, id: session.user_id, pushes: [], matched: null };
    socket.onnotification = (n) => u.pushes.push(typeof n.content === "string" ? JSON.parse(n.content) : n.content);
    socket.onmatchmakermatched = (m) => { u.matched = m; };
    await socket.connect(session, true);
    // caps: communitanCaps value (default: everything this server needs)
    u.rpc = async (id, fields = {}, challenge = false, caps = CAPS()) => {
        const req = { requestId: `${Date.now()}_${++reqN}`, ...fields };
        if (caps) req.communitanCaps = caps;
        if (id.endsWith("Request")) req["@class"] = "." + id;
        else { req["@class"] = challenge ? ".LogChallengeEventRequest" : ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        return typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    };
    users.push(u);
    return u;
}
async function push(u, ext, pred = () => true, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const i = u.pushes.findIndex((m) => m.extCode === ext && pred(m));
        if (i >= 0) return u.pushes.splice(i, 1)[0];
        await sleep(50);
    }
    return null;
}

async function listing() {
    console.log("== listing");
    const st = await (await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`)).json();
    RNG = st.rng || "off";
    const g = (st.gameModes || []).find((m) => m.id === "robbers");
    ok(g && g.name && g.players.min === 3 && g.players.max === 4, "status gameModes lists robbers");
    const pub = await (await fetch(`${BASE}/v2/rpc/COMMUNITAN_MODES?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`)).json();
    const d = (pub.modes || []).find((m) => m.id === "robbers");
    ok(d && d.rules.dice.fixedSum === 7 && d.rules.roundGrant.count === 2 && d.gameInfo.useShuffleMap === false, "COMMUNITAN_MODES (public) has the full robbers definition");
    const u = await mkUser("l");
    const r = await u.rpc("COMMUNITAN_MODES");
    ok(!r.error && sd(r).modes && sd(r).modes.some((m) => m.id === "robbers"), "COMMUNITAN_MODES as GS request");
    u.socket.disconnect(false);
}

// Mode tickets (asking for 2 players) are clamped to the mode's exact count (3) and only match their mode; plain tickets
// never match mode tickets; an unknown mode matches nobody here.
async function matchmaker() {
    console.log("== matchmaker pools");
    const m = [await mkUser("m1"), await mkUser("m2"), await mkUser("m3")];
    const p = [await mkUser("p1"), await mkUser("p2")];
    const x = await mkUser("x1");
    const add = (u, mode) => u.socket.addMatchmaker(`+properties.mmtest:${RUN}`, 2, 2, Object.assign({ mmtest: RUN, matchType: "QUICK_MATCH", expansions: "CatanBaseGame" }, mode ? { ccsMode: mode } : {}), { skill: 1000 });
    await add(m[0], "robbers");
    await add(p[0]);
    await add(x, "nosuchmode");
    await add(m[1], "robbers");
    await add(p[1]);
    await add(m[2], "robbers");
    const end = Date.now() + 45000;
    while ([...m, ...p].some((u) => !u.matched) && Date.now() < end) await sleep(200);
    await sleep(6000); // one more matchmaker interval for x
    const ids = (u) => (u.matched ? u.matched.users.map((y) => y.presence.user_id).sort().join() : "");
    ok(m.every((u) => ids(u) === m.map((y) => y.id).sort().join()), "the 3 robbers tickets matched together (clamped to 3 players)");
    ok(p.every((u) => ids(u) === p.map((y) => y.id).sort().join()), "the 2 plain tickets matched together, no mode ticket");
    ok(!x.matched, "unknown-mode ticket matched nobody");
    return { m, p };
}

async function joinAndRequest(group, gi, caps) {
    const out = [];
    for (const u of group) {
        const mt = await u.socket.joinMatch(u.matched.match_id || undefined, u.matched.token);
        const playerIds = u.matched.users.map((y) => y.presence.user_id);
        const r = await u.rpc("MatchmakingRequest", { matchShortCode: "FREEMATCH_3P", participantData: { gameInformation: gi, platform: "Steam" }, matchData: { expansion: "CatanBaseGame" }, skill: 1000, playerIds, matchId: mt.match_id }, false, caps);
        out.push({ u, r, matchId: mt.match_id });
        await u.socket.leaveMatch(mt.match_id);
    }
    return out;
}

async function freePlay({ m, p }) {
    console.log("== Free Play mode game");
    if (!m.every((u) => u.matched)) return;
    const gi = { matchType: "QUICK_MATCH", expansions: ["CatanBaseGame"], scenarios: [""], minPlayers: 3, maxPlayers: 3, useShuffleMap: false, ccsMode: "robbers" };
    // no modes caps: refused before anything is created
    const mt0 = await m[0].socket.joinMatch(m[0].matched.match_id || undefined, m[0].matched.token);
    let r = await m[0].rpc("MatchmakingRequest", { participantData: { gameInformation: gi }, playerIds: m.map((u) => u.id), matchId: mt0.match_id }, false, NOMODE());
    ok(errCode(r) === 110 && /mod/i.test(r.error.customErrorMessage || ""), "MatchmakingRequest for a mode without modes-1 -> 110 + update-mod message");
    await m[0].socket.leaveMatch(mt0.match_id);
    const res = await joinAndRequest(m, gi);
    ok(res.every((x) => !x.r.error), "MatchmakingRequest with mode ok");
    const matchId = res[0].matchId;
    const found = [];
    for (const u of m) found.push(await push(u, "MatchFoundMessage"));
    ok(found.every((f) => f && f.scriptData.ccsMode === "robbers" && f.scriptData.ccsModeDef && f.scriptData.ccsModeDef.rules.dice.fixedSum === 7), "MatchFoundMessage carries ccsMode + ccsModeDef");
    ok(found.every((f) => f && f.scriptData.useShuffleMap === false), "mode gameInfo overrides the Free Play shuffle (useShuffleMap false)");
    if (!found[0]) return;
    const seats = found[0].scriptData.sortedPlayerIds;
    const creator = m.find((u) => u.id === found[0].participants[0].userId);
    // a client that dropped the mode keys: the match record decides
    const g2 = Object.assign({}, found[0].scriptData);
    delete g2.ccsMode; delete g2.ccsModeDef;
    r = await creator.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", usersToChallenge: m.filter((u) => u !== creator).map((u) => u.id),
        scriptData: { challengeInstanceId: matchId, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: g2 } });
    ok(!r.error, "CreateChallenge ok");
    const C = { challengeInstanceId: matchId };
    for (const u of m) {
        const d = sd(await u.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: matchId }));
        ok(d.ccsMode === "robbers" && d.ccsModeDef && d.ccsModeDef.rules.roundGrant.count === 2 && d.useShuffleMap === false, "details: ccsMode + ccsModeDef " + u.tag);
    }
    r = await m[1].rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: matchId }, false, NOMODE());
    ok(errCode(r) === 110 && /mode/i.test(r.error.customErrorMessage || ""), "details without modes-1 -> 110");
    r = await m[1].rpc("GAME_GET_GAMESTATE_AND_ACTIONS_V3", { CHALLENGE_ID: matchId }, true, NOMODE());
    ok(errCode(r) === 110, "state without modes-1 -> 110");
    const sA = seats.indexOf(creator.id);
    const act = (u, seat, aid, b, caps) => u.rpc("GAME_ACTION_V3", { ...C, GAME_ACTION_STATE: b, ACTION_OWNER_INDEX: seat, ACTION_ID: aid, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" }, true, caps);
    r = await act(creator, sA, 1, rollBlob(500, sA, [1, 1]), NOMODE());
    ok(errCode(r) === 110, "action without modes-1 -> 110");
    const pairs = new Set();
    let allSeven = true;
    for (let i = 0; i < 20; i++) {
        r = await act(creator, sA, 2 + i, rollBlob(600 + i, sA, [1, 1]));
        if (r.error) { allSeven = false; break; }
        if (RNG === "full") {
            const d = (sd(r).ccsRng || {}).d || [];
            if (d.length !== 2 || d[0] + d[1] !== 7 || d.some((v) => v < 1 || v > 6)) allSeven = false;
            pairs.add(d.join(","));
        }
    }
    if (RNG === "full") ok(allSeven && pairs.size >= 2, `full RNG: 20 server rolls all sum 7 (${pairs.size} distinct pairs)`);
    else ok(allSeven, `rolls accepted (${RNG}: client dice)`);
    const st = sd(await m[2].rpc("GAME_GET_GAMESTATE_AND_ACTIONS_V3", { CHALLENGE_ID: matchId }, true));
    ok(st.ccsMode === "robbers" && st.ccsModeDef && st.gameActions.length === 20, "state: ccsMode + ccsModeDef (rejoin)");
    // result: unranked
    r = await creator.rpc("GAME_WON", { CHALLENGE_ID: matchId, WON: 1, EXPANSION: "CatanBaseGame", MAP: "Base", SINGLEPLAYER: 0,
        WIN_LOSE: { win_lose: seats.map((id, i) => ({ playerId: id, rank: i + 1, victorypoints: 10 - i })) } });
    ok(!r.error, "GAME_WON ok");
    const res2 = await push(creator, "GAME_MULTIPLAYER_RESULT", () => true, 15000);
    ok(res2 && res2.data.win_lose.length === 3 && res2.data.win_lose.every((x) => x.increaseElo === 0 && x.placementMatchesPlayed === 0 && x.xpEarned > 0), "mode result: no ELO change, no placement, XP counted");
    const lb = await client.listLeaderboardRecords(creator.session, "PLAYER_ELO_RANKING.EXPANSION.CatanBaseGame", m.map((u) => u.id));
    ok(!(lb.owner_records || []).length, "no ELO leaderboard records for mode players");

    // plain Free Play match: a client-injected ccsMode is dropped (the match record has no mode)
    if (!p.every((u) => u.matched)) return;
    const pgi = { matchType: "QUICK_MATCH", expansions: ["CatanBaseGame"], scenarios: [""], minPlayers: 2, maxPlayers: 2 };
    const pres = await joinAndRequest(p, pgi, NOMODE());
    const pf = await push(p[0], "MatchFoundMessage");
    ok(pres.every((x) => !x.r.error) && pf && !pf.scriptData.ccsMode, "plain match: no mode");
    if (!pf) return;
    const pc = p.find((u) => u.id === pf.participants[0].userId);
    r = await pc.rpc("CreateChallengeRequest", { usersToChallenge: p.filter((u) => u !== pc).map((u) => u.id),
        scriptData: { challengeInstanceId: pres[0].matchId, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: Object.assign({}, pf.scriptData, { ccsMode: "robbers" }) } });
    const pd = sd(await pc.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: pres[0].matchId }));
    ok(!r.error && pd.ccsMode === undefined && pd.ccsModeDef === undefined, "plain match: injected ccsMode ignored");
}

// Custom games (lobby path, no match record): the creator's gameInfo.ccsMode is validated.
async function custom() {
    console.log("== custom CreateChallenge");
    const [a, b, c] = [await mkUser("c1"), await mkUser("c2"), await mkUser("c3")];
    const gi = (mode, ids) => ({ matchType: "CUSTOM_MATCH", expansions: ["CatanBaseGame"], scenarios: ["firstisland"], sortedPlayerIds: ids, ccsMode: mode, useShuffleMap: true });
    const create = (id, mode, ids, caps) => a.rpc("CreateChallengeRequest", { usersToChallenge: ids.filter((x) => x !== a.id),
        scriptData: { challengeInstanceId: id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: gi(mode, ids) } }, false, caps);
    const three = [a.id, b.id, c.id];
    let r = await create("cm-nocaps-" + RUN, "robbers", three, NOMODE());
    ok(errCode(r) === 110, "custom mode game without modes-1 -> 110");
    r = await create("cm-unknown-" + RUN, "nosuchmode", three);
    ok(errCode(r) === 110 && /mode/i.test(r.error.customErrorMessage || ""), "unknown mode -> 110");
    r = await create("cm-two-" + RUN, "robbers", [a.id, b.id]);
    ok(errCode(r) === 110 && /3-4 players/.test(r.error.customErrorMessage || ""), "mode with 2 players -> 110 (needs 3-4)");
    const id = "cm-ok-" + RUN;
    r = await create(id, "robbers", three);
    ok(!r.error, "custom robbers game created");
    const d = sd(await b.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: id }));
    ok(d.ccsMode === "robbers" && d.ccsModeDef.id === "robbers" && d.useShuffleMap === false, "custom: details carry the mode, mode gameInfo applied");
    r = await c.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: id }, false, NOMODE());
    ok(errCode(r) === 110, "custom: details without modes-1 -> 110");
}

// Custom lobby (G2): the host's gameInfo.ccsMode is validated + kept (overrides applied, no def), every member needs
// "modes-1", the mode's seat count is checked at LOBBY_START_GAME, and the start push carries the mode.
async function lobby() {
    console.log("== custom lobby");
    const [h, a, b, x] = [await mkUser("h"), await mkUser("a"), await mkUser("b"), await mkUser("x")];
    const gi = (mode, extra = {}) => Object.assign({ connectionType: "CUSTOM_MATCH", matchType: "CUSTOM_MATCH", expansions: ["CatanBaseGame"],
        scenarios: ["firstisland"], useShuffleMap: true, victoryPoints: 10 }, mode ? { ccsMode: mode } : {}, extra);
    let r = await h.rpc("LOBBY_CREATE", { GAME_INFO: gi("robbers") }, false, NOMODE());
    ok(errCode(r) === 110 && /mod/i.test(r.error.customErrorMessage || ""), "LOBBY_CREATE with a mode without modes-1 -> 110");
    r = await h.rpc("LOBBY_CREATE", { GAME_INFO: gi("nosuchmode") });
    ok(errCode(r) === 110 && /mode/i.test(r.error.customErrorMessage || ""), "LOBBY_CREATE with an unknown mode -> 110");
    r = await h.rpc("LOBBY_CREATE", { GAME_INFO: gi("robbers") });
    const L = sd(r), LOBBY_ID = L.lobbyId;
    ok(!r.error && L.ccsMode === "robbers" && L.useShuffleMap === false && L.ccsModeDef === undefined, "LOBBY_CREATE: mode kept, mode gameInfo applied (useShuffleMap false), no def");
    // invitees: the modded one sees the mode in the invite; an unmodded one cannot accept
    await h.rpc("LOBBY_INVITE", { LOBBY_ID, PLAYER_ID: a.id });
    const inv = await push(a, "LOBBY_INVITE");
    ok(inv && inv.data.ccsMode === "robbers", "LOBBY_INVITE push carries ccsMode");
    await h.rpc("LOBBY_INVITE", { LOBBY_ID, PLAYER_ID: x.id });
    r = await x.rpc("LOBBY_ACCEPT", { LOBBY_ID }, false, NOMODE());
    ok(errCode(r) === 110 && /mod/i.test(r.error.customErrorMessage || ""), "LOBBY_ACCEPT of a mode lobby without modes-1 -> 110");
    r = await h.rpc("LOBBY_GET_GAMEINFO", { LOBBY_ID });
    ok(!(sd(r).lobbyPlayers || []).some((p) => p.userId === x.id), "unmodded invitee did not join");
    r = await a.rpc("LOBBY_ACCEPT", { LOBBY_ID });
    ok(!r.error && sd(r).ccsMode === "robbers", "LOBBY_ACCEPT (modded): lobby update carries the mode");
    // host switches the expansion: the server drops the mode; back to robbers: members see it again
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID, GAME_INFO: gi("robbers", { expansions: ["CatanSeafarer"] }), REMOVE_PLAYER_ID: "-" });
    let p = await push(a, "LOBBY_UPDATE_GAMEINFO");
    ok(!r.error && p && p.data.ccsMode === undefined, "mode dropped when the lobby is not base game");
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID, GAME_INFO: gi("robbers"), REMOVE_PLAYER_ID: "-" });
    p = await push(a, "LOBBY_UPDATE_GAMEINFO");
    ok(!r.error && p && p.data.ccsMode === "robbers" && p.data.useShuffleMap === false, "LOBBY_UPDATE_GAMEINFO push carries the mode (non-host members see it)");
    // a member's later request without the capability (old mod) blocks updates/start of the mode game
    await a.rpc("LOBBY_PLAYER_IS_READY", { LOBBY_ID, IS_READY: 1 }, false, NOMODE());
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID, GAME_INFO: gi("robbers"), REMOVE_PLAYER_ID: "-" });
    ok(errCode(r) === 110 && /must update/i.test(r.error.customErrorMessage || ""), "member without modes-1 -> mode refused, names the member");
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID, GAME_INFO: gi(null), REMOVE_PLAYER_ID: "-" });
    p = await push(a, "LOBBY_UPDATE_GAMEINFO");
    ok(!r.error && p && p.data.ccsMode === undefined, "Standard (no mode) still possible with that member");
    await a.rpc("LOBBY_PLAYER_IS_READY", { LOBBY_ID, IS_READY: 1 });
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID, GAME_INFO: gi("robbers"), REMOVE_PLAYER_ID: "-" });
    ok(!r.error, "member updated its mod -> mode accepted again");
    // seat count: robbers needs 3-4 seats (humans + AI)
    r = await h.rpc("LOBBY_START_GAME", { LOBBY_ID, GAME_INFO: { gameInfo: gi("robbers", { sortedPlayerIds: [h.id, a.id] }) } });
    ok(errCode(r) === 110 && /3-4 players/.test(r.error.customErrorMessage || ""), "LOBBY_START_GAME with 2 seats -> 110 (needs 3-4)");
    r = await h.rpc("LOBBY_START_GAME", { LOBBY_ID, GAME_INFO: { gameInfo: gi("robbers", { sortedPlayerIds: [h.id, a.id, "Lena"] }) } });
    ok(!r.error && sd(r).canStart === true && sd(r).ccsMode === "robbers" && sd(r).useShuffleMap === false, "LOBBY_START_GAME (2 humans + AI): canStart, mode kept");
    p = await push(a, "LOBBY_START_GAME");
    ok(p && p.data.ccsMode === "robbers", "LOBBY_START_GAME push carries the mode");
    // the host's CreateChallenge with the lobby game info -> mode game (details for the member)
    r = await h.rpc("CreateChallengeRequest", { usersToChallenge: [a.id], scriptData: { challengeInstanceId: LOBBY_ID, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: sd(r) } });
    const d = sd(await a.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: LOBBY_ID }));
    ok(!r.error && d.ccsMode === "robbers" && d.ccsModeDef && d.ccsModeDef.rules.dice.fixedSum === 7, "lobby game: details carry ccsMode + ccsModeDef");
    // plain lobby: an unmodded member joins; the host then cannot switch to a mode
    r = await h.rpc("LOBBY_CREATE", { GAME_INFO: gi(null) });
    const L2 = sd(r).lobbyId;
    ok(!r.error && sd(r).ccsMode === undefined, "plain lobby without mode");
    await h.rpc("LOBBY_INVITE", { LOBBY_ID: L2, PLAYER_ID: b.id });
    r = await b.rpc("LOBBY_ACCEPT", { LOBBY_ID: L2 }, false, NOMODE());
    ok(!r.error, "unmodded player joins a plain lobby");
    r = await h.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID: L2, GAME_INFO: gi("robbers"), REMOVE_PLAYER_ID: "-" });
    ok(errCode(r) === 110 && /must update/i.test(r.error.customErrorMessage || ""), "plain lobby with an unmodded member: mode refused");
    for (const u of [h, a, b]) { await u.rpc("LOBBY_LEAVE", { LOBBY_ID }); await u.rpc("LOBBY_LEAVE", { LOBBY_ID: L2 }); }
}

function serverErrors() {
    try {
        const since = Math.floor(T0.getTime() / 1000) - 1;
        const log = execSync(`${CONTAINER_CLI} logs --since ${since} ${CONTAINER} 2>&1`, { encoding: "utf8", maxBuffer: 64 << 20 });
        return log.split("\n").filter((l) => /"level":"error"/.test(l));
    } catch (e) {
        console.log("(server log check skipped: " + e.message.split("\n")[0] + ")");
        return [];
    }
}

try {
    await listing();
    console.log("server rng: " + RNG);
    const g = await matchmaker();
    await freePlay(g);
    await custom();
    await lobby();
} catch (e) {
    failures++;
    console.error("FAIL: exception", e);
}
for (const u of users) {
    try { await u.rpc("ACCOUNT_DELETE_REQUEST"); } catch (e) { /* ignore */ }
    try { u.socket.disconnect(false); } catch (e) { /* ignore */ }
}
const errs = serverErrors();
for (const l of errs) console.error("SERVER ERROR:", l.slice(0, 300));
ok(errs.length === 0, "server log free of errors");
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
