// Multiplayer protocol bot: npm run test:mp (server must be running: podman-compose up -d).
// Drives device users through matchmaker -> MatchmakingRequest -> CreateChallenge -> setup -> actions -> reconnect -> GAME_WON,
// and a custom lobby (create/invite/accept/decline/ready/start) -> AFK kick -> exit. Contract: docs/protocol/multiplayer.md
import { Client } from "@heroiclabs/nakama-js";
import { execSync } from "node:child_process";
import { HOSTNAME, PORT, SSL, SERVER_KEY, CONTAINER, BASE, HTTP_KEY, CONTAINER_CLI } from "./env.mjs";

const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const RUN = Date.now().toString(36);
const T0 = new Date();
const called = new Set();
let failures = 0, passes = 0;
let reqN = 0;

function ok(cond, msg) {
    if (cond) passes++;
    else { failures++; console.error("FAIL:", msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal Thrift TBinary encoder/decoder for CommonGameActionState blobs (fields used by the server, mp_rng.ts).
const F = (t, id, val) => [t, (id >> 8) & 255, id & 255, ...val];
const I32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const STRUCT = (...fields) => [...fields.flat(), 0];
const LIST_I32 = (vs) => [8, ...I32(vs.length), ...vs.flatMap(I32)];
// act = catanActionId (3 Base_RollDice, 13 BuyDevelopmentCard, 14 EndTurn, 151 Cak_RollDice)
function blob({ act = 14, player = 0, uid, sync = uid, dice, ai = false, extra = 0, alch }) {
    const cgas = [F(8, 1, I32(act)), F(8, 4, I32(1))];
    if (alch) cgas.push(F(12, 3008, STRUCT(F(8, 1, I32(alch[0])), F(8, 2, I32(alch[1])), F(8, 3, I32(alch[2])))));
    if (extra) cgas.push(F(8, 5, I32(extra)));
    if (dice) cgas.push(F(12, 1000, STRUCT(F(15, 1, LIST_I32(dice)))));
    const top = [F(12, 1, STRUCT(F(8, 1, I32(act)))), F(8, 2, I32(player)), F(8, 3, I32(uid)), F(12, 10, STRUCT(...cgas))];
    if (ai) top.push(F(2, 19, [1]));
    top.push(F(8, 20, I32(player)), F(8, 23, I32(sync)));
    return Buffer.from(STRUCT(...top)).toString("base64");
}
// {uid, dice} of a blob (dice = field 10 -> 1000 -> 1)
function unblob(b64) {
    const b = Buffer.from(b64, "base64");
    const out = { uid: -1, dice: null, alch: null };
    const skip = (p, t) => {
        if (t === 2 || t === 3) return p + 1;
        if (t === 6) return p + 2;
        if (t === 8) return p + 4;
        if (t === 4 || t === 10) return p + 8;
        if (t === 11) return p + 4 + b.readInt32BE(p);
        if (t === 12) return fields(p, () => -1);
        if (t === 15 || t === 14) { let q = p + 5; for (let i = 0; i < b.readInt32BE(p + 1); i++) q = skip(q, b[p]); return q; }
        throw new Error("type " + t);
    };
    const fields = (p, visit) => {
        for (;;) {
            const t = b[p++];
            if (t === 0) return p;
            const id = b.readInt16BE(p); p += 2;
            const e = visit(id, t, p);
            p = e >= 0 ? e : skip(p, t);
        }
    };
    fields(0, (id, t, p) => {
        if (id === 3) out.uid = b.readInt32BE(p);
        if (id === 10) return fields(p, (i2, t2, p2) => i2 === 3008 ? fields(p2, (i3, t3, p3) => { (out.alch = out.alch || [])[i3 - 1] = b.readInt32BE(p3); return -1; }) : i2 !== 1000 ? -1 : fields(p2, (i3, t3, p3) => {
            if (i3 === 1) { out.dice = []; for (let i = 0; i < b.readInt32BE(p3 + 1); i++) out.dice.push(b.readInt32BE(p3 + 5 + 4 * i)); }
            return -1;
        }));
        return -1;
    });
    return out;
}

const users = []; // deleted at the end so test players never stay on the leaderboards
async function mkUser(tag) {
    const session = await client.authenticateDevice(`mp-test-${tag}-${RUN}`, true, `mp${tag}${RUN}`);
    const socket = client.createSocket(SSL, false);
    const u = { tag, session, socket, id: session.user_id, pushes: [], matched: null, caps: RNG === "full" };
    socket.onnotification = (n) => u.pushes.push(typeof n.content === "string" ? JSON.parse(n.content) : n.content);
    socket.onmatchmakermatched = (m) => { u.matched = m; };
    await socket.connect(session, true);
    u.rpc = async (id, fields = {}, challenge = false) => {
        called.add(id);
        const req = { requestId: `${Date.now()}_${++reqN}`, ...fields };
        if (u.caps) req.communitanCaps = "rng-full-1"; // the mod's capability token (sent with every request on custom servers)
        if (id.endsWith("Request")) req["@class"] = "." + id;
        else { req["@class"] = challenge ? ".LogChallengeEventRequest" : ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
        if (p.requestId !== req.requestId) throw new Error(`${id}: requestId not echoed`);
        return p;
    };
    users.push(u);
    return u;
}

// Waits for a push with extCode (and optional predicate); removes and returns it.
async function push(u, ext, pred = () => true, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const i = u.pushes.findIndex((m) => m.extCode === ext && pred(m));
        if (i >= 0) return u.pushes.splice(i, 1)[0];
        await sleep(50);
    }
    return null;
}
const noPush = async (u, ext, ms = 700) => (await push(u, ext, () => true, ms)) === null;
const sd = (r) => r.scriptData || {};
// Server RNG level from the public status (CATAN_SERVER_RNG): "off" -> the creator's seeds are kept, "seeds" -> server-made.
let RNG = "off";
const isSeed = (v) => Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;
// expected seeds for a session created with client seeds `cli` ([seed, colorSeed, diceSeed]); first answer fixes them
function seedCheck(cli) {
    let fixed = null;
    return (d) => {
        const got = [d.seed, d.colorSeed, d.diceSeed];
        if (RNG === "off") return got.join() === cli.join();
        if (!got.every(isSeed) || got.join() === cli.join()) return false;
        if (!fixed) fixed = got;
        return got.join() === fixed.join();
    };
}
const errCode = (r) => (r.error ? r.error.errorCode : 0);

async function matchFlow() {
    console.log("== matchmaker flow");
    const [a, b] = [await mkUser("a"), await mkUser("b")];
    for (const u of [a, b]) await u.socket.addMatchmaker(`+properties.mmtest:${RUN}`, 2, 2, { mmtest: RUN, matchType: "QUICK_MATCH" }, { skill: 1000 });
    const end = Date.now() + 45000;
    while ((!a.matched || !b.matched) && Date.now() < end) await sleep(200);
    ok(a.matched && b.matched, "matchmaker matched both");
    if (!a.matched || !b.matched) return;
    const matchIds = [];
    for (const u of [a, b]) {
        const m = await u.socket.joinMatch(u.matched.match_id || undefined, u.matched.token);
        matchIds.push(m.match_id);
        await u.socket.joinChat(m.match_id, 1, true, false);
        const playerIds = u.matched.users.map((x) => x.presence.user_id);
        const gi = { matchType: "QUICK_MATCH", expansions: ["CatanBaseGame"], scenarios: [u.tag === "a" ? "ScenA" : "ScenB"], minPlayers: 2, maxPlayers: 2, useKicktimer: true };
        const r = await u.rpc("MatchmakingRequest", { matchShortCode: "FREEMATCH_2P", participantData: { gameInformation: gi, platform: "Steam" }, matchData: { expansion: "CatanBaseGame" }, skill: 1000, playerIds, matchId: m.match_id });
        ok(r["@class"] === ".MatchmakingResponse" && !r.error, "MatchmakingRequest ok");
        await u.socket.leaveMatch(m.match_id);
    }
    ok(matchIds[0] === matchIds[1], "same match id for both");
    const matchId = matchIds[0];
    const fa = await push(a, "MatchFoundMessage"), fb = await push(b, "MatchFoundMessage");
    ok(fa && fb, "MatchFoundMessage to both");
    if (!fa || !fb) return;
    ok(fa.matchId === matchId && fb.matchId === matchId, "MatchFound matchId");
    ok(JSON.stringify(fa.participants.map((p) => p.userId)) === JSON.stringify(fb.participants.map((p) => p.userId)), "same participant order (dedupe)");
    ok(fa.scriptData.scenarios[0] === fb.scriptData.scenarios[0], "same scenario pick (dedupe)");
    const seats = fa.scriptData.sortedPlayerIds;
    const creator = [a, b].find((u) => u.id === fa.participants[0].userId);
    const other = creator === a ? b : a;
    const sA = seats.indexOf(creator.id), sB = seats.indexOf(other.id);

    let r = await other.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 0, currentChallengeId: matchId });
    ok(!sd(r).currentChallengeId, "no session before CreateChallenge");
    const create = { challengeShortCode: "CATAN", autoStartJoinedChallengeOnMaxPlayers: true, minPlayers: 2, maxPlayers: 2, usersToChallenge: [other.id],
        scriptData: { challengeInstanceId: matchId, seed: 11, colorSeed: 22, diceSeed: 33, gameInfo: fa.scriptData } };
    r = await creator.rpc("CreateChallengeRequest", create);
    ok(!r.error && r["@class"] === ".CreateChallengeResponse", "CreateChallenge ok");
    r = await creator.rpc("CreateChallengeRequest", create);
    ok(!r.error, "CreateChallenge durable retry ok");

    r = await other.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 0, currentChallengeId: matchId });
    ok(sd(r).currentChallengeId === matchId && sd(r).challengeState === "RUNNING" && sd(r).playerDetails.length === 2, "poll -> RUNNING with playerDetails");
    r = await other.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 1 });
    ok(sd(r).currentChallengeId === matchId, "cold-start current session via pointer");
    r = await other.rpc("GAME_GET_CURRENT_CHALLENGE_ID");
    ok(sd(r).challengeId === matchId, "GAME_GET_CURRENT_CHALLENGE_ID");

    const seedsOk = seedCheck([11, 22, 33]);
    for (const u of [creator, other]) {
        r = await u.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: matchId });
        const d = sd(r);
        ok(seedsOk(d), `GAME_DETAILS_V3 seeds (${RNG}) ` + u.tag);
        ok(d.hostIdx === Math.min(sA, sB) && d.playerDetails.length === 2 && Array.isArray(d.allLastPlayedActionsPerPlayer), "GAME_DETAILS_V3 " + u.tag);
    }
    const C = { challengeInstanceId: matchId };
    await creator.rpc("GAME_PLAYER_SETUP_READY", { ...C, GAMESTATE: "" }, true);
    const sl = await push(other, "GAME_SCENE_LOADED");
    ok(sl && sl.data.playerId === creator.id && sl.data.challengeId === matchId, "GAME_SCENE_LOADED to other");
    ok(await noPush(creator, "GAME_START_GAMELOGIC"), "no START before all ready");
    await other.rpc("GAME_PLAYER_SETUP_READY", { ...C, GAMESTATE: "" }, true);
    ok(await push(creator, "GAME_START_GAMELOGIC") && await push(other, "GAME_START_GAMELOGIC"), "GAME_START_GAMELOGIC to both");
    await creator.rpc("GAME_PLAYER_SETUP_READY", { ...C, GAMESTATE: "" }, true);
    ok(await push(creator, "GAME_START_GAMELOGIC"), "late SETUP_READY gets START again");
    for (const u of [creator, other]) {
        r = await u.rpc("GAME_PLAYER_HAS_STARTED_GAMELOGIC", C, true);
        ok(sd(r).playersStartedIds.includes(u.id), "playersStartedIds has me " + u.tag);
        await u.rpc("GAME_PLAYER_IN_GAME");
    }

    const [B1, B2, B3, B4, B5, B6, B7] = [blob({ uid: 51, player: sA }), blob({ uid: 52, player: sA }), blob({ uid: 71, player: sB }), blob({ uid: 31, player: sA }),
        blob({ uid: 72, player: sA }), blob({ uid: 72, player: sA, extra: 1 }), blob({ uid: 91, player: sB })];
    const act = (u, seat, id, blob, extra = {}) => u.rpc("GAME_ACTION_V3", { ...C, GAME_ACTION_STATE: blob, ACTION_OWNER_INDEX: seat, ACTION_ID: id,
        CONTEXTS: { contexts: [{ playerIdx: seat, turntimer: 90, contextSwitchId: id, contextId: "ctx" + id, nextUniqueId: id * 10, previousContextId: "p", lastPlayedUniqueId: id * 10 - 1, lastPlayedActionIdContext: "x" }] },
        TURNTIMER_RAN_OUT_PLAYER_ID: "-", TURNTIMER_INFO: { playerIdx: seat, timer: 42.5 }, ...extra }, true);
    r = await act(creator, sA, 5, B1);
    ok(sd(r).lastPlayedActionId === 5, "action accepted");
    let p = await push(other, "GAME_ACTION_PLAYED");
    ok(p && p.data.actionOwnerId === sA && p.data.lastPlayedActionId === 5 && p.data.gameActionState === B1 && p.data.turntimer_timer === 42.5 && p.data.playerId === creator.id, "GAME_ACTION_PLAYED relayed");
    ok(await noPush(creator, "GAME_ACTION_PLAYED", 300), "no echo to sender");
    r = await act(creator, sA, 5, B1);
    ok(!r.error && sd(r).lastPlayedActionId === 5, "duplicate (durable retry) idempotent");
    ok(await noPush(other, "GAME_ACTION_PLAYED"), "duplicate not relayed");
    r = await act(creator, sA, 5, B2);
    ok(!r.error, "same ACTION_ID, new action (same context) accepted");
    r = await act(other, sB, 7, B3);
    ok(!r.error, "other seat action accepted");
    const roll = blob({ act: 3, uid: 73, player: sB, dice: [7, 7] });
    r = await act(other, sB, 7, roll);
    p = await push(creator, "GAME_ACTION_PLAYED", (m) => unblob(m.data.gameActionState).uid === 73);
    if (RNG === "full") ok(!r.error && p && sd(r).ccsRng && JSON.stringify(unblob(p.data.gameActionState).dice) === JSON.stringify(sd(r).ccsRng.d) && sd(r).ccsRng.d.every((v) => v >= 1 && v <= 6), "roll dice rewritten by server (full)");
    else ok(!r.error && p && p.data.gameActionState === roll && !sd(r).ccsRng && !p.data.ccsRng, `roll relayed unchanged (${RNG})`);
    r = await act(creator, sA, 3, B4);
    ok(errCode(r) === 111, "stale ACTION_ID -> 111");
    const tt = (u, id, blob) => u.rpc("GAME_ACTION_TURNTIMER", { ...C, GAME_ACTION_STATE: blob, ACTION_OWNER_INDEX: sA, ACTION_ID: id, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: creator.id, TURNTIMER_INFO: { playerIdx: sA, timer: 0 } }, true);
    r = await tt(other, 7, B5);
    ok(!r.error, "turntimer action accepted");
    p = await push(creator, "GAME_ACTION_TURNTIMER_PLAYED");
    ok(p && p.data.actionOwnerId === sA && p.data.lastPlayedActionId === 7, "GAME_ACTION_TURNTIMER_PLAYED relayed");
    r = await tt(creator, 7, B6);
    ok(errCode(r) === 111, "second copy of same turntimer -> 111");

    r = await creator.rpc("GAME_PING_V3", { ...C, TIMERS: { timers: [{ index: 0, timer: 30 }] } }, true);
    const lp = Object.fromEntries(sd(r).allLastPlayedActionsPerPlayer.map((x) => [x.playerIndex, x.lastPlayed]));
    ok(lp[sA] === 7 && lp[sB] === 7 && sd(r).hostIdx === Math.min(sA, sB), "ping lastPlayed + hostIdx");

    await creator.rpc("GAME_TRADE", { ...C, PLAYER_IDS: { playerIds: [creator.id, other.id] }, TRADE: { give: [1] }, TRADE_TYPE: "Catan.RTTModel, Assembly-CSharp", TURNTIMER_INFO: { playerIdx: sA, timer: 10 } }, true);
    p = await push(other, "GAME_TRADE");
    ok(p && p.data.tradeType === "Catan.RTTModel, Assembly-CSharp" && p.data.trade.give[0] === 1 && p.data.turntimer_playerIdx === sA, "GAME_TRADE relayed");
    p = await push(creator, "GAME_TRADE");
    ok(p && p.data.trade.give[0] === 1, "GAME_TRADE echoed to sender (client only processes its own trade via the echo)");
    await creator.rpc("GAME_MULTICAST_TURNTIMERS", { ...C, TIMERS: { timers: [{ index: 1, timer: 12.5 }] } }, true);
    p = await push(other, "GAME_MULTICAST_TURNTIMERS");
    ok(p && p.data.timers[0].timer === 12.5, "GAME_MULTICAST_TURNTIMERS relayed");
    await creator.rpc("CHAT_EMOJI", { PLAYER_IDS: { playerIds: [other.id] }, EMOJI_ID: "smile" });
    p = await push(other, "CHAT_EMOJI");
    ok(p && p.data.emojiId === "smile" && typeof p.data.who === "string", "CHAT_EMOJI relayed");
    await creator.rpc("GAME_SET_PLAYER_MUTED", { ...C, PLAYER_ID: other.id, IS_MUTED: 1 }, true);
    r = await creator.rpc("GAME_GET_MUTED_PLAYERS", C, true);
    ok(sd(r).mutedPlayerIds.includes(other.id), "mute stored");
    r = await creator.rpc("GAME_GET_TURNTIMERS");
    ok(sd(r).turntimers.default.CatanBaseGame === 90, "GAME_GET_TURNTIMERS");

    const host = sA < sB ? creator : other, nonHost = host === creator ? other : creator;
    await host.rpc("GAME_PLAYER_LEFT", { ...C, FORCED_QUIT: "False" }, true);
    p = await push(nonHost, "GAME_PAUSED");
    ok(p && p.data.isPaused === true && p.data.playerId === host.id && p.data.hostIdx === Math.max(sA, sB) && p.data.playerData.length === 1, "GAME_PAUSED + host switch");
    r = await nonHost.rpc("GAME_GET_KICKTIMERS", { CHALLENGE_ID: matchId });
    ok(sd(r).playerData.length === 1 && sd(r).playerData[0].isKickTimerRunning, "kick timer running");
    await host.rpc("GAME_PLAYER_RETURNED", C, true);
    p = await push(nonHost, "GAME_PAUSED");
    ok(p && p.data.isPaused === false && p.data.hostIdx === Math.min(sA, sB), "GAME_PAUSED false + host back");
    r = await host.rpc("GAME_STILL_IN_GAME", { CHALLENGE_ID: matchId });
    ok(sd(r).isInGame === true, "GAME_STILL_IN_GAME");

    r = await other.rpc("GAME_GET_GAMESTATE_AND_ACTIONS_V3", { CHALLENGE_ID: matchId });
    let d = sd(r);
    ok(JSON.stringify(d.gameActions.filter((x) => unblob(x).uid !== 73)) === JSON.stringify([B1, B2, B3, B5]) && d.contextId === "ctx7" && seedsOk(d), "reconnect state + ordered actions");
    ok(RNG === "full" ? d.ccsRng.length === 5 && d.ccsRng.every((x, i) => x.u === unblob(d.gameActions[i]).uid && /^[0-9a-f]{16}$/.test(x.w)) : d.ccsRng === undefined && d.ccsRngMode === undefined,
        `state rng records (${RNG})`);
    await other.rpc("GAME_SYNC_STATISTICS", { ...C, CONTEXT_NAME: "x", REASON: "Reconnect" }, true);

    r = await creator.rpc("GAME_WON", { CHALLENGE_ID: matchId, WON: 1, EXPANSION: "CatanBaseGame", MAP: "Base", SINGLEPLAYER: 0, ITS_THE_FINAL_GAMESTATE: "RkZGRg==",
        WIN_LOSE: { win_lose: [{ playerId: creator.id, rank: 1, victorypoints: 10 }, { playerId: other.id, rank: 2, victorypoints: 6 }], playTime: "00:00:10:00" } });
    ok(!r.error, "GAME_WON ok");
    for (const u of [creator, other]) {
        p = await push(u, "GAME_MULTIPLAYER_RESULT");
        const me = p && p.data.win_lose.find((x) => x.playerId === u.id);
        ok(me && me.rank === (u === creator ? 1 : 2) && me.xpEarned > 0 && Math.abs(me.increaseElo) <= 100 && (u === creator ? me.increaseElo > 0 : me.increaseElo < 0) && p.data.startDate && p.data.gameInfo.sortedPlayerIds.length === 2, "GAME_MULTIPLAYER_RESULT " + u.tag);
    }
    // Real-client finding: the game never deletes notifications it got live, only those it lists at login -> a persisted
    // result for an online player is shown again at every later login. Persist only for offline participants.
    for (const u of [creator, other]) {
        const nl = await client.listNotifications(u.session, 100);
        const stored = (nl.notifications || []).filter((n) => JSON.stringify(n.content).includes("GAME_MULTIPLAYER_RESULT"));
        ok(stored.length === 0, "result not persisted for online " + u.tag);
    }
    r = await creator.rpc("GAME_WON", { CHALLENGE_ID: matchId, WON: 1, SINGLEPLAYER: 0, WIN_LOSE: { win_lose: [] } });
    ok(!r.error, "GAME_WON idempotent");
    ok(await noPush(other, "GAME_MULTIPLAYER_RESULT"), "no second result");
    r = await other.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 1 });
    ok(!sd(r).currentChallengeId, "no current session after finish");
    r = await act(other, sB, 9, B7);
    ok(errCode(r) === 24, "action after finish -> 24");
    r = await creator.rpc("GAME_WON", { CHALLENGE_ID: "", SINGLEPLAYER: 1, WON: 1 });
    ok(!r.error, "single-player GAME_WON ack");
    for (const u of [a, b]) u.socket.disconnect(false);
}

async function lobbyFlow() {
    console.log("== lobby flow");
    const [o, pl, q] = [await mkUser("o"), await mkUser("p"), await mkUser("q")];
    const gi = { matchType: "CUSTOM_MATCH", expansions: ["CatanBaseGame"], scenarios: ["Base"], minPlayers: 3, maxPlayers: 4, sortedPlayerIds: [o.id], useKicktimer: true, aiReplacesPlayers: true };
    let r = await o.rpc("LOBBY_CREATE", { GAME_INFO: gi });
    const lobbyId = sd(r).lobbyId;
    ok(lobbyId && sd(r).ownerId === o.id && sd(r).readyPlayerIds.includes(o.id), "LOBBY_CREATE");
    await o.rpc("LOBBY_INVITE", { LOBBY_ID: lobbyId, PLAYER_ID: pl.id });
    let p = await push(pl, "LOBBY_INVITE");
    ok(p && p.data.lobbyId === lobbyId && p.data.player.userId === o.id, "LOBBY_INVITE push");
    p = await push(o, "LOBBY_UPDATE_PLAYERS");
    ok(p && p.data.invitedPlayers.length === 1, "LOBBY_UPDATE_PLAYERS after invite");
    await o.rpc("LOBBY_INVITE", { LOBBY_ID: lobbyId, PLAYER_ID: q.id });
    await o.rpc("LOBBY_INVITE", { LOBBY_ID: lobbyId, PLAYER_ID: "Lena" });
    ok(await push(q, "LOBBY_INVITE"), "invite q");
    r = await o.rpc("LOBBY_GET_GAMEINFO", { LOBBY_ID: lobbyId });
    ok(sd(r).aiPlayerIds.includes("Lena") && sd(r).sortedPlayerIds.length === 4, "AI invite -> aiPlayerIds");
    o.pushes.length = 0;
    r = await pl.rpc("LOBBY_ACCEPT", { LOBBY_ID: lobbyId });
    ok(sd(r).lobbyPlayers.some((x) => x.userId === pl.id) && !sd(r).invitedPlayers.some((x) => x.userId === pl.id), "LOBBY_ACCEPT resp");
    ok(await push(o, "LOBBY_UPDATE_PLAYERS"), "owner notified of accept");
    await q.rpc("LOBBY_DECLINE", { LOBBY_ID: lobbyId });
    p = await push(o, "LOBBY_UPDATE_PLAYERS", (m) => !m.data.sortedPlayerIds.includes(q.id));
    ok(p, "decline removes q");
    r = await o.rpc("LOBBY_START_GAME", { LOBBY_ID: lobbyId, GAME_INFO: { gameInfo: { ...gi, sortedPlayerIds: [o.id, pl.id, "Lena"] } } });
    ok(sd(r).canStart === false, "cannot start before ready");
    await pl.rpc("LOBBY_PLAYER_IS_READY", { LOBBY_ID: lobbyId, IS_READY: 1 });
    p = await push(o, "LOBBY_UPDATE_PLAYERS", (m) => m.data.readyPlayerIds.includes(pl.id));
    ok(p, "ready pushed");
    await o.rpc("LOBBY_UPDATE_GAME_INFO", { LOBBY_ID: lobbyId, GAME_INFO: { ...gi, sortedPlayerIds: [o.id, pl.id, "Lena"] }, REMOVE_PLAYER_ID: "-" });
    ok(await push(pl, "LOBBY_UPDATE_GAMEINFO"), "LOBBY_UPDATE_GAMEINFO push");
    const startGi = { ...gi, sortedPlayerIds: [o.id, pl.id, "Lena"] };
    r = await o.rpc("LOBBY_START_GAME", { LOBBY_ID: lobbyId, GAME_INFO: { gameInfo: startGi } });
    ok(sd(r).canStart === true && sd(r).challengeId === lobbyId, "LOBBY_START_GAME canStart");
    p = await push(pl, "LOBBY_START_GAME");
    ok(p && p.data.lobbyId === lobbyId && p.data.sortedPlayerIds.length === 3, "LOBBY_START_GAME push");
    r = await pl.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 0, currentChallengeId: lobbyId });
    ok(!sd(r).currentChallengeId, "no session until CreateChallenge");
    r = await o.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", usersToChallenge: [pl.id], scriptData: { challengeInstanceId: lobbyId, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: { ...startGi, lobbyId } } });
    ok(!r.error, "lobby CreateChallenge");
    r = await pl.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 0, currentChallengeId: lobbyId });
    const ai = sd(r).playerDetails && sd(r).playerDetails[2];
    ok(sd(r).challengeState === "RUNNING" && ai && ai.isAi === true && ai.userId === "Lena", "lobby session RUNNING with AI seat");
    const lobbySeeds = seedCheck([1, 2, 3]);
    for (const u of [o, pl]) ok(lobbySeeds(sd(await u.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: lobbyId }))), `lobby seeds (${RNG}) ` + u.tag);
    const C = { challengeInstanceId: lobbyId };
    for (const u of [o, pl]) await u.rpc("GAME_PLAYER_SETUP_READY", { ...C, GAMESTATE: "" }, true);
    ok(await push(o, "GAME_START_GAMELOGIC") && await push(pl, "GAME_START_GAMELOGIC"), "lobby game started");
    // host (seat 0) sends AI actions for seat 2, plus 3 turn timer expiries of p (seat 1) -> AFK kick
    r = await o.rpc("GAME_ACTION_V3", { ...C, GAME_ACTION_STATE: blob({ uid: 5, player: 2, ai: true }), ACTION_OWNER_INDEX: 2, ACTION_ID: 1, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" }, true);
    ok(!r.error && await push(pl, "GAME_ACTION_PLAYED", (m) => m.data.actionOwnerId === 2), "AI seat action by host relayed");
    for (let i = 1; i <= 3; i++) {
        r = await o.rpc("GAME_ACTION_TURNTIMER", { ...C, GAME_ACTION_STATE: blob({ uid: 10 + i, player: 1 }), ACTION_OWNER_INDEX: 1, ACTION_ID: i, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: pl.id }, true);
        ok(!r.error, "turntimer " + i);
    }
    ok(await push(pl, "GAME_PLAYER_AFK_KICKED"), "GAME_PLAYER_AFK_KICKED to p");
    p = await push(o, "GAME_PLAYER_WAS_KICKED");
    ok(p && p.data.playerId === pl.id && p.data.hostIdx === 0, "GAME_PLAYER_WAS_KICKED to host");
    ok(await push(pl, "GAME_PLAYER_WAS_KICKED"), "GAME_PLAYER_WAS_KICKED to kicked");
    r = await pl.rpc("GAME_ACTION_V3", { ...C, GAME_ACTION_STATE: blob({ uid: 20, player: 1 }), ACTION_OWNER_INDEX: 1, ACTION_ID: 9, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" }, true);
    ok(errCode(r) === 46, "kicked player action -> 46");
    r = await pl.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: lobbyId });
    ok(sd(r).kickedPlayerDetails.some((x) => x.userId === pl.id), "kickedPlayerDetails");
    r = await pl.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 1 });
    ok(sd(r).wasKickedFromChallengeId === lobbyId && sd(r).wasKickedReason === "AFK_3X_TURNTIMER" && sd(r).currentChallengeId === lobbyId, "wasKicked flag");
    r = await pl.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 1 });
    ok(!sd(r).currentChallengeId && !sd(r).wasKickedFromChallengeId, "wasKicked flag cleared");
    r = await o.rpc("GAME_EXIT_SESSION", { REASON: "test" });
    ok(!r.error, "GAME_EXIT_SESSION");
    r = await o.rpc("GAME_GET_CURRENT_SESSION", { REMOVE_WAS_KICKED_FLAG: 1 });
    ok(!sd(r).currentChallengeId, "no session after exit");
    for (const u of [pl, o]) await u.rpc("LOBBY_LEAVE", { LOBBY_ID: lobbyId });
    r = await o.rpc("LOBBY_GET_GAMEINFO", { LOBBY_ID: lobbyId });
    ok(errCode(r) === 24, "empty lobby deleted");
    for (const u of [o, pl, q]) u.socket.disconnect(false);
}

// CATAN_SERVER_RNG=full (mp_rng.ts): mod gate, server dice, per-action words, UniqueId binding, dice deck.
const sameRec = (x, y) => !!x && !!y && x.u === y.u && x.w === y.w && JSON.stringify(x.d) === JSON.stringify(y.d); // push JSON key order differs
async function rngFlow() {
    console.log("== rng full flow");
    const [a, b, x] = [await mkUser("ra"), await mkUser("rb"), await mkUser("rx")];
    x.caps = false;
    let r = await x.rpc("LOBBY_CREATE", { GAME_INFO: { matchType: "CUSTOM_MATCH" } });
    ok(errCode(r) === 110 && /update the Communitan mod/i.test(r.error.customErrorMessage || ""), "no mod capability -> LOBBY_CREATE refused with message");
    r = await x.rpc("MatchmakingRequest", { matchShortCode: "FREEMATCH_2P", matchId: "m-" + RUN, playerIds: [x.id] });
    ok(errCode(r) === 110, "no mod capability -> MatchmakingRequest refused");
    const mk = async (id, gi) => {
        const create = { challengeShortCode: "CATAN", usersToChallenge: [b.id], scriptData: { challengeInstanceId: id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: { sortedPlayerIds: [a.id, b.id], matchType: "CUSTOM_MATCH", ...gi } } };
        x.caps = false;
        const rx = await x.rpc("CreateChallengeRequest", { ...create, scriptData: { ...create.scriptData, challengeInstanceId: id + "x" } });
        ok(errCode(rx) === 110, "no mod capability -> CreateChallenge refused");
        ok(!(await a.rpc("CreateChallengeRequest", create)).error, "rng CreateChallenge " + id);
    };
    const id = "rng-" + RUN, C = { challengeInstanceId: id };
    await mk(id, {});
    b.caps = false;
    r = await b.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: id });
    ok(errCode(r) === 110 && r.error.customErrorMessage, "full session: details without capability refused");
    b.caps = true;
    const det = sd(await b.rpc("GAME_GET_GAME_DETAILS_V3", { CHALLENGE_ID: id }));
    ok(det.ccsRngMode === "full" && det.seed !== 1 && det.diceSeed !== 3, "details: ccsRngMode full + server seeds");
    ok(!/rngU|rngStack|"h":/.test(JSON.stringify(det)), "details expose no rng internals");
    const act = (u, seat, aid, bl, extra = {}) => u.rpc("GAME_ACTION_V3", { ...C, GAME_ACTION_STATE: bl, ACTION_OWNER_INDEX: seat, ACTION_ID: aid, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-", ...extra }, true);
    b.caps = false;
    r = await act(b, 1, 1, blob({ uid: 9, player: 1 }));
    ok(errCode(r) === 110, "action without capability refused");
    b.caps = true;
    r = await act(a, 0, 1, "AAAA");
    ok(errCode(r) === 110, "unreadable blob refused");
    // roll: client dice [7,7] (impossible) -> server dice in ack, push and stored blob
    const roll = blob({ act: 3, uid: 10, dice: [7, 7] });
    r = await act(a, 0, 1, roll);
    const rr = sd(r).ccsRng;
    let p = await push(b, "GAME_ACTION_PLAYED");
    ok(rr && rr.u === 10 && /^[0-9a-f]{16}$/.test(rr.w) && rr.d.length === 2 && rr.d.every((v) => v >= 1 && v <= 6), "roll ack carries server dice + word");
    ok(p && sameRec(p.data.ccsRng, rr) && JSON.stringify(unblob(p.data.gameActionState).dice) === JSON.stringify(rr.d), "push: rewritten blob + same word/dice");
    r = await act(a, 0, 1, roll);
    ok(sameRec(sd(r).ccsRng, rr) && await noPush(b, "GAME_ACTION_PLAYED", 400), "durable retry: same dice/word, no relay");
    r = await act(a, 0, 1, blob({ act: 3, uid: 10, dice: [7, 7], ai: true }));
    p = await push(b, "GAME_ACTION_PLAYED");
    ok(!r.error && sameRec(sd(r).ccsRng, rr) && p && JSON.stringify(unblob(p.data.gameActionState).dice) === JSON.stringify(rr.d), "same UniqueId, identical payload (AI flag copy): same dice/word");
    r = await act(a, 0, 1, blob({ act: 3, uid: 10, dice: [1, 1] }));
    ok(errCode(r) === 111, "same UniqueId, other payload -> 111 (word cannot be probed)");
    // dev card buy / any action: fresh word only on acceptance
    const before = JSON.stringify(sd(await b.rpc("GAME_GET_GAMESTATE_AND_ACTIONS_V3", { CHALLENGE_ID: id })));
    r = await act(a, 0, 2, blob({ act: 13, uid: 11 }));
    const wBuy = sd(r).ccsRng;
    ok(wBuy && wBuy.u === 11 && !wBuy.d && wBuy.w !== rr.w && !before.includes(wBuy.w), "buy: fresh word, unknown before acceptance");
    p = await push(b, "GAME_ACTION_PLAYED");
    ok(p && p.data.ccsRng.w === wBuy.w, "buy word identical for every client (push == ack)");
    // turntimer path + C&K roll (3 dice)
    r = await a.rpc("GAME_ACTION_TURNTIMER", { ...C, GAME_ACTION_STATE: blob({ act: 151, uid: 12, player: 1, dice: [0, 0, 0] }), ACTION_OWNER_INDEX: 1, ACTION_ID: 3, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: b.id }, true);
    ok(!r.error && sd(r).ccsRng && sd(r).ccsRng.d.length === 3, "turntimer C&K roll: 3 server dice");
    p = await push(b, "GAME_ACTION_TURNTIMER_PLAYED");
    ok(p && sameRec(p.data.ccsRng, sd(r).ccsRng), "turntimer push carries the same record");
    const ttW = sd(r).ccsRng.w;
    // C&K Alchemist: production dice chosen by the player stay, the event die comes from the server
    r = await act(a, 0, 4, blob({ act: 210, uid: 13, alch: [3, 4, 9] }));
    p = await push(b, "GAME_ACTION_PLAYED");
    const al = p && unblob(p.data.gameActionState).alch;
    ok(!r.error && sd(r).ccsRng.d.length === 1 && al && al[0] === 3 && al[1] === 4 && al[2] === sd(r).ccsRng.d[0] && al[2] >= 1 && al[2] <= 6, "alchemist: event die rewritten, chosen dice kept " + JSON.stringify(al));
    // many rolls: values in range, not constant, words unique
    const words = new Set([rr.w, wBuy.w, ttW, sd(r).ccsRng.w]), sums = new Set();
    let allOk = true;
    for (let i = 0; i < 40; i++) {
        r = await act(b, 1, 10 + i, blob({ act: 3, uid: 100 + i, player: 1, dice: [6, 6] }));
        const c = sd(r).ccsRng;
        if (!c || c.d.length !== 2 || !c.d.every((v) => v >= 1 && v <= 6)) allOk = false;
        else { sums.add(c.d[0] + c.d[1]); words.add(c.w); }
        await push(a, "GAME_ACTION_PLAYED");
    }
    ok(allOk && sums.size >= 5 && words.size === 44, `40 rolls: d6 values, ${sums.size} distinct sums, unique words`);
    // reconnect replay: state blobs are the rewritten ones, records aligned with gameActions, same words as live
    const st = sd(await b.rpc("GAME_GET_GAMESTATE_AND_ACTIONS_V3", { CHALLENGE_ID: id }));
    ok(st.ccsRngMode === "full" && st.gameActions.length === st.ccsRng.length && st.ccsRng.every((c, i) => c.u === unblob(st.gameActions[i]).uid), "state: one record per action, aligned");
    ok(JSON.stringify(unblob(st.gameActions[0]).dice) === JSON.stringify(rr.d) && st.ccsRng[0].w === rr.w && st.ccsRng[2].w === wBuy.w, "state replays server dice and live words");
    // dice deck (gameInfo.diceMode, the game's "dice stack"): 36 rolls = each pair once
    const id2 = "rngdeck-" + RUN;
    await mk(id2, { diceMode: true });
    const pairs = new Set();
    for (let i = 0; i < 36; i++) {
        r = await a.rpc("GAME_ACTION_V3", { challengeInstanceId: id2, GAME_ACTION_STATE: blob({ act: 3, uid: 1000 + i, dice: [1, 1] }), ACTION_OWNER_INDEX: 0, ACTION_ID: i, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" }, true);
        const c = sd(r).ccsRng;
        if (c) pairs.add(c.d.join(","));
    }
    ok(pairs.size === 36, `dice deck: 36 rolls gave ${pairs.size} distinct pairs`);
    for (const u of [a, b, x]) u.socket.disconnect(false);
}

function serverErrors() {
    try {
        const since = Math.floor(T0.getTime() / 1000) - 1;
        const log = execSync(`${CONTAINER_CLI} logs --since ${since} ${CONTAINER} 2>&1`, { encoding: "utf8", maxBuffer: 64 << 20 });
        return log.split("\n").filter((l) => /"level":"error"/.test(l) && [...called].some((id) => l.includes(`"rpc_id":"${id.toLowerCase()}"`) || l.includes(`rpc ${id} `)));
    } catch (e) {
        console.log("(server log check skipped: " + e.message.split("\n")[0] + ")");
        return [];
    }
}

try {
    const st = await (await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`)).json();
    RNG = st.rng || "off";
    ok(RNG === "off" || RNG === "seeds" || RNG === "full", "status rng " + RNG);
    if (process.env.EXPECT_RNG) ok(RNG === process.env.EXPECT_RNG, `server rng ${RNG} == EXPECT_RNG ${process.env.EXPECT_RNG}`);
    console.log("server rng: " + RNG);
    await matchFlow();
    await lobbyFlow();
    if (RNG === "full") await rngFlow();
} catch (e) {
    failures++;
    console.error("FAIL: exception", e);
}
for (const u of users) {
    try { await u.rpc("ACCOUNT_DELETE_REQUEST"); } catch (e) { console.error("cleanup", u.tag, e.message || e); }
}
const errs = serverErrors();
for (const l of errs) console.error("SERVER ERROR:", l);
ok(errs.length === 0, "server log free of errors for mp rpcs");
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
