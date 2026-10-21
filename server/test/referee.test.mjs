// L3 referee test: npm run test:referee. Only runs against a server with CATAN_SERVER_RULES=audit|enforce and a running
// referee (CATAN_REFEREE_URL); otherwise it skips. Plays recorded real matches (referee/test/fixtures) through GAME_WON:
// session + action chunks are written via the console API (seeds of the recording), then one player sends GAME_WON with a
// forged WIN_LOSE. Checks verdict storage, enforce result override, cheater ranked last + kick reason + cheat record.
// M2 inline (rules=enforce + rng=off only): a recording sent action by action via GAME_ACTION_V3 (honest prefix accepted;
// forged dice -> 46, not stored/relayed, sender kicked INVALID_GAME_DATA, l3_cheats inline record).
// Contract: docs/design/level3-referee.md. Env: NAKAMA_HOST, NAKAMA_CONSOLE, CONSOLE_USERNAME/PASSWORD, NAKAMA_CONTAINER.
import { Client } from "@heroiclabs/nakama-js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { HOSTNAME, PORT, SSL, SERVER_KEY, BASE, HTTP_KEY, CONTAINER, CONTAINER_CLI } from "./env.mjs";

const CONSOLE = process.env.NAKAMA_CONSOLE || "http://127.0.0.1:7351";
const SYS = "00000000-0000-0000-0000-000000000000";
const FIX = new URL("../../referee/test/fixtures/", import.meta.url);
const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const RUN = Date.now().toString(36);
const T0 = new Date();
let failures = 0, passes = 0, reqN = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.error("FAIL:", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const users = [];

async function mkUser(tag) {
    const session = await client.authenticateDevice(`l3-test-${tag}-${RUN}`, true, `l3${tag}${RUN}`);
    const socket = client.createSocket(SSL, false);
    const u = { tag, session, id: session.user_id, pushes: [] };
    socket.onnotification = (n) => u.pushes.push(typeof n.content === "string" ? JSON.parse(n.content) : n.content);
    await socket.connect(session, true);
    u.socket = socket;
    u.rpc = async (id, fields = {}) => {
        const req = { requestId: `${Date.now()}_${++reqN}`, communitanCaps: "rng-full-1", ...fields };
        if (id.endsWith("Request")) req["@class"] = "." + id; else { req["@class"] = ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        return typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    };
    users.push(u);
    return u;
}

let token = null;
async function con(method, path, body) {
    if (!token) {
        const r = await fetch(`${CONSOLE}/v2/console/authenticate`, { method: "POST", body: JSON.stringify({ username: process.env.CONSOLE_USERNAME || "admin", password: process.env.CONSOLE_PASSWORD || "catanadmin" }) });
        token = (await r.json()).token;
    }
    const r = await fetch(CONSOLE + path, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
    return r.ok ? r.json() : null;
}
const getObj = async (coll, key, uid = SYS) => { const o = await con("GET", `/v2/console/storage/${coll}/${encodeURIComponent(key)}/${uid}`); return o && o.value ? JSON.parse(o.value) : null; };
const putObj = (coll, key, value, uid = SYS) => con("PUT", `/v2/console/storage/${coll}/${encodeURIComponent(key)}/${uid}`, { value: JSON.stringify(value), permission_read: 0, permission_write: 0 });

// Dice offsets of a Base_RollDice blob (field 10 -> 1000 -> 1 list<i32>): minimal TBinary walker (see mp.test.mjs).
function diceOffsets(buf) {
    const out = [];
    const skip = (p, t) => {
        if (t === 2 || t === 3) return p + 1;
        if (t === 6) return p + 2;
        if (t === 8) return p + 4;
        if (t === 4 || t === 10) return p + 8;
        if (t === 11) return p + 4 + buf.readInt32BE(p);
        if (t === 12) return fields(p, () => -1);
        if (t === 13) { let q = p + 6; for (let i = 0; i < buf.readInt32BE(p + 2); i++) { q = skip(q, buf[p]); q = skip(q, buf[p + 1]); } return q; }
        if (t === 15 || t === 14) { let q = p + 5; for (let i = 0; i < buf.readInt32BE(p + 1); i++) q = skip(q, buf[p]); return q; }
        throw new Error("type " + t);
    };
    const fields = (p, visit) => {
        for (;;) {
            const t = buf[p++];
            if (t === 0) return p;
            const id = buf.readInt16BE(p); p += 2;
            const e = visit(id, t, p);
            p = e >= 0 ? e : skip(p, t);
        }
    };
    let act = -1, player = -1, uid = -1, by = -1, sync = -1;
    fields(0, (id, t, p) => {
        if (id === 1 && t === 12) return fields(p, (i2, t2, p2) => { if (i2 === 1 && t2 === 8) act = buf.readInt32BE(p2); return -1; });
        if (id === 2 && t === 8) player = buf.readInt32BE(p);
        if (id === 3 && t === 8) uid = buf.readInt32BE(p);
        if (id === 20 && t === 8) by = buf.readInt32BE(p); // ActionPlayedByPlayerIdx
        if (id === 23 && t === 8) sync = buf.readInt32BE(p); // NetworkSyncId = the client's ACTION_ID
        if (id === 10 && t === 12) return fields(p, (i2, t2, p2) => i2 === 1000 && t2 === 12 ? fields(p2, (i3, t3, p3) => {
            if (i3 === 1 && t3 === 15) for (let i = 0; i < buf.readInt32BE(p3 + 1); i++) out.push(p3 + 5 + 4 * i);
            return -1;
        }) : -1);
        return -1;
    });
    return { act, player, uid, by: by >= 0 ? by : player, sync: sync >= 0 ? sync : uid, dice: out };
}

// Forged dice of the first roll of `seat` at index > `after` (rng off: dice are fixed by the game's dice RNG).
function forgeRoll(blobs, seat, after) {
    const k = blobs.findIndex((b, i) => { const d = diceOffsets(Buffer.from(b, "base64")); return i > after && d.act === 3 && d.player === seat && d.dice.length === 2; });
    const buf = Buffer.from(blobs[k], "base64");
    const o = diceOffsets(buf).dice[0];
    buf.writeInt32BE(buf.readInt32BE(o) === 6 ? 5 : 6, o);
    return { k, blob: buf.toString("base64") };
}

// M2 inline (enforce): a live session fed action by action through GAME_ACTION_V3 by the seat owners, like real clients.
// Sends blobs[0..n) (forged blob at index `tamper.k` if given) and stops at the first error.
async function playLive(fx, seatUsers, n, tamper) {
    const id = crypto.randomUUID();
    const map = Object.fromEntries(fx.session.seats.map((p, i) => [p, seatUsers[i].id]));
    const gi = { ...fx.session.gameInfo, sortedPlayerIds: fx.session.seats.map((p) => map[p]) };
    const [creator, ...others] = seatUsers;
    const { seed, colorSeed, diceSeed } = fx.session; // rng off: the server keeps the creator's seeds
    const cr = await creator.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", minPlayers: 2, maxPlayers: 4, usersToChallenge: others.map((u) => u.id), scriptData: { challengeInstanceId: id, seed, colorSeed, diceSeed, gameInfo: gi } });
    ok(!cr.error, "live CreateChallenge " + JSON.stringify(cr.error || ""));
    const s0 = await getObj("sessions", id);
    ok(s0 && s0.seed === seed && s0.diceSeed === diceSeed, "live session keeps the recorded seeds");
    if (s0 && s0.gameInfo.useShuffleMap !== fx.session.gameInfo.useShuffleMap) { // CATAN_SHUFFLE_FREEPLAY=on: back to the recorded board
        s0.gameInfo.useShuffleMap = fx.session.gameInfo.useShuffleMap;
        ok(await putObj("sessions", id, s0), "live session board restored");
    }
    for (const u of seatUsers) u.pushes.length = 0;
    const out = { id, accepted: 0, err: null, ms: [] };
    for (let i = 0; i < n; i++) {
        const blob = tamper && i === tamper.k ? tamper.blob : fx.actions[i].a;
        const d = diceOffsets(Buffer.from(blob, "base64"));
        const t = Date.now();
        const r = await seatUsers[d.by].rpc("GAME_ACTION_V3", { challengeInstanceId: id, GAME_ACTION_STATE: blob, ACTION_OWNER_INDEX: d.player, ACTION_ID: d.sync, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" });
        out.ms.push(Date.now() - t);
        if (r.error) { out.err = { i, code: r.error.errorCode, sender: seatUsers[d.by] }; break; }
        out.accepted++;
    }
    out.session = await getObj("sessions", id);
    return out;
}

// One recorded match on a fresh session: CreateChallenge (real session record), then seeds/rng/actions from the recording.
async function play(fx, seatUsers, tamper) {
    const id = crypto.randomUUID();
    const map = Object.fromEntries(fx.session.seats.map((p, i) => [p, seatUsers[i].id]));
    const gi = { ...fx.session.gameInfo, sortedPlayerIds: fx.session.seats.map((p) => map[p]) };
    const [creator, ...others] = seatUsers;
    const cr = await creator.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", minPlayers: 2, maxPlayers: 4, usersToChallenge: others.map((u) => u.id), scriptData: { challengeInstanceId: id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: gi } });
    ok(!cr.error, "CreateChallenge " + JSON.stringify(cr.error || ""));
    const s = await getObj("sessions", id);
    let blobs = fx.actions.map((x) => x.a);
    let cheatSeat = -1;
    if (tamper) {
        const f = forgeRoll(blobs, 1, 20); // forged dice of a later roll of seat 1
        blobs = blobs.slice();
        blobs[f.k] = f.blob;
        cheatSeat = 1;
    }
    for (let c = 0; c * 64 < blobs.length; c++) {
        const a = blobs.slice(c * 64, c * 64 + 64);
        const by = a.map((b) => seatUsers[diceOffsets(Buffer.from(b, "base64")).player].id); // sender = seat owner
        ok(await putObj("session_actions", `${id}#${c}`, { gen: s.gen, a, s: by }), "actions written");
    }
    s.gameInfo.useShuffleMap = fx.session.gameInfo.useShuffleMap; // the recorded board (CATAN_SHUFFLE_FREEPLAY=on forces a shuffle)
    Object.assign(s, { rng: fx.session.rng, seed: fx.session.seed, diceSeed: fx.session.diceSeed, colorSeed: fx.session.colorSeed, nActions: blobs.length, logicStarted: true });
    ok(await putObj("sessions", id, s), "session written");
    // forged claim: seat 0 says it won
    const wl = seatUsers.map((u, i) => ({ playerId: u.id, rank: i === 0 ? 1 : 2, victorypoints: i === 0 ? 10 : 5 }));
    const r = await creator.rpc("GAME_WON", { CHALLENGE_ID: id, WON: 1, EXPANSION: "CatanBaseGame", SINGLEPLAYER: 0, WIN_LOSE: { win_lose: wl } });
    ok(!r.error, "GAME_WON ok");
    let res = null;
    for (let i = 0; i < 100 && !res; i++) {
        const m = creator.pushes.find((p) => p.extCode === "GAME_MULTIPLAYER_RESULT" && p.data.challengeId === id);
        if (m) res = m.data;
        else await sleep(100);
    }
    ok(res, "result pushed");
    const rank = Object.fromEntries(((res && res.win_lose) || []).map((x) => [x.playerId, x.rank]));
    return { id, rank, rec: await getObj("l3_verdicts", id), cheat: cheatSeat >= 0 ? seatUsers[cheatSeat] : null };
}

try {
    const st = await (await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`)).json();
    const mode = st.rules || "off";
    if (mode === "off") {
        console.log("referee test skipped: server rules off (CATAN_SERVER_RULES=audit|enforce + CATAN_REFEREE_URL)");
        process.exit(0);
    }
    if (!(await con("GET", "/v2/console/status"))) {
        console.log("referee test skipped: console not reachable (NAKAMA_CONSOLE)");
        process.exit(0);
    }
    console.log("server rules: " + mode);
    const fx = JSON.parse(readFileSync(new URL("21c5098f.json", FIX), "utf8")); // 2 players, rng off, recorded winner p1
    const [a, b] = [await mkUser("a"), await mkUser("b")];
    await a.rpc("ChangeUserDetailsRequest", { displayName: `L3a${RUN}` });
    await b.rpc("ChangeUserDetailsRequest", { displayName: `L3b${RUN}` });

    console.log("== honest match, forged claim");
    let g = await play(fx, [a, b], false);
    ok(g.rec && g.rec.verdict && g.rec.verdict.supported === true && g.rec.verdict.ok === true, "verdict stored: ok " + JSON.stringify(g.rec && g.rec.verdict).slice(0, 300));
    ok(g.rec && g.rec.claimed && g.rec.claimed[a.id] === 1, "claimed ranks recorded");
    if (mode === "enforce") ok(g.rank[b.id] === 1 && g.rank[a.id] === 2, "enforce: ranks from the replay (b won) " + JSON.stringify(g.rank));
    else ok(g.rank[a.id] === 1 && g.rank[b.id] === 2, "audit: claimed ranks kept " + JSON.stringify(g.rank));

    console.log("== cheater (forged dice by seat 1 = recorded winner)");
    g = await play(fx, [a, b], true);
    const inv = g.rec && g.rec.verdict && g.rec.verdict.invalid;
    ok(inv && inv.senderId === b.id && inv.playerId === b.id && /dice/.test(inv.reason), "verdict invalid for b " + JSON.stringify(inv));
    ok(g.rec && g.rec.cheater === b.id, "cheater recorded");
    const cheat = await getObj("l3_cheats", g.id, b.id);
    const cur = await b.rpc("GAME_GET_CURRENT_SESSION", {});
    if (mode === "enforce") {
        ok(g.rank[a.id] === 1 && g.rank[b.id] === 2, "enforce: cheater ranked last " + JSON.stringify(g.rank));
        ok(cheat && cheat.uid === inv.uid, "l3_cheats record for b " + JSON.stringify(cheat));
        ok(cur.scriptData && cur.scriptData.wasKickedReason === "INVALID_GAME_DATA" && cur.scriptData.wasKickedFromChallengeId === g.id, "b sees kick reason " + JSON.stringify(cur.scriptData));
        const s = await getObj("sessions", g.id);
        ok(s.pres[b.id].kicked === "INVALID_GAME_DATA" && s.state === "COMPLETED", "session: kicked INVALID_GAME_DATA");
    } else {
        ok(!cheat, "audit: no cheat record");
        ok(!(cur.scriptData && cur.scriptData.wasKickedReason), "audit: no kick");
    }

    console.log("== unsupported scenario");
    const id = crypto.randomUUID();
    await a.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", minPlayers: 2, maxPlayers: 2, usersToChallenge: [b.id], scriptData: { challengeInstanceId: id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: { matchType: "QUICK_MATCH", expansions: ["CatanSeafarer"], scenarios: ["SfDrought"], sortedPlayerIds: [a.id, b.id] } } });
    await a.rpc("GAME_WON", { CHALLENGE_ID: id, WON: 1, EXPANSION: "CatanSeafarer", SINGLEPLAYER: 0, WIN_LOSE: { win_lose: [{ playerId: a.id, rank: 1, victorypoints: 10 }, { playerId: b.id, rank: 2, victorypoints: 5 }] } });
    const rec = await getObj("l3_verdicts", id);
    ok(rec && rec.verdict.supported === false && !rec.cheater, "unsupported: recorded, nothing changed " + JSON.stringify(rec && rec.verdict));
    const s = await getObj("sessions", id);
    ok(s && s.state === "COMPLETED" && s.result.win_lose.find((x) => x.playerId === a.id).rank === 1, "unsupported: claimed result kept");

    // ---- M2 inline: GAME_ACTION_V3 checked before store/relay (enforce; rng off so the recording's dice are the reference) ----
    if (mode !== "enforce" || (st.rng || "off") !== "off") {
        console.log(`== inline: skipped (needs rules=enforce and rng=off, server has rules=${mode} rng=${st.rng})`);
    } else {
        console.log("== inline: honest prefix");
        const N = 150;
        let g = await playLive(fx, [a, b], N, null);
        ok(g.accepted === N && !g.err, `honest prefix: ${g.accepted}/${N} accepted ` + JSON.stringify(g.err && { i: g.err.i, code: g.err.code }));
        ok(g.session.nActions === N && !g.session.l3, "honest prefix: stored, still checked inline (s.l3 unset) " + (g.session.l3 || ""));
        ok(!Object.values(g.session.pres).some((p) => p.kicked), "honest prefix: nobody kicked");
        ok(b.pushes.filter((p) => p.extCode === "GAME_ACTION_PLAYED" && p.data.challengeId === g.id).length > 0, "honest prefix: actions relayed");
        const ms = g.ms.slice().sort((x, y) => x - y);
        console.log(`   inline latency per action: median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms (${g.ms.length} actions)`);

        console.log("== inline: forged dice by seat 1 mid-game");
        const f = forgeRoll(fx.actions.map((x) => x.a), 1, 90);
        g = await playLive(fx, [a, b], f.k + 1, f);
        ok(g.accepted === f.k && g.err && g.err.i === f.k && g.err.code === 46, `earlier ${f.k} actions accepted, forged one -> 46 ` + JSON.stringify(g.err && { i: g.err.i, code: g.err.code }));
        ok(g.err && g.err.sender === b, "forged action sent by b");
        ok(g.session.nActions === f.k, "forged action not stored (nActions " + g.session.nActions + ")");
        ok(g.session.pres[b.id].kicked === "INVALID_GAME_DATA" && !g.session.pres[a.id].kicked && g.session.state !== "COMPLETED", "b kicked INVALID_GAME_DATA, game goes on");
        let kp = null;
        for (let i = 0; i < 50 && !kp; i++) {
            kp = a.pushes.find((p) => p.extCode === "GAME_PLAYER_WAS_KICKED" && p.data.challengeId === g.id);
            if (!kp) await sleep(100);
        }
        ok(kp && kp.data.playerId === b.id, "a gets GAME_PLAYER_WAS_KICKED for b");
        ok(!a.pushes.some((p) => p.extCode === "GAME_ACTION_PLAYED" && p.data.gameActionState === f.blob), "forged action not relayed");
        const cheat = await getObj("l3_cheats", g.id, b.id);
        ok(cheat && cheat.inline === true && /dice/.test(cheat.reason) && cheat.uid === diceOffsets(Buffer.from(f.blob, "base64")).uid, "l3_cheats inline record " + JSON.stringify(cheat));
        const again = await b.rpc("GAME_ACTION_V3", { challengeInstanceId: g.id, GAME_ACTION_STATE: fx.actions[f.k].a, ACTION_OWNER_INDEX: 1, ACTION_ID: diceOffsets(Buffer.from(fx.actions[f.k].a, "base64")).sync, CONTEXTS: { contexts: [] }, TURNTIMER_RAN_OUT_PLAYER_ID: "-" });
        ok(again.error && again.error.errorCode === 46, "kicked sender's next action -> 46");
        const cur = await b.rpc("GAME_GET_CURRENT_SESSION", {});
        ok(cur.scriptData && cur.scriptData.wasKickedReason === "INVALID_GAME_DATA", "b sees kick reason " + JSON.stringify(cur.scriptData && cur.scriptData.wasKickedReason));
    }
} catch (e) {
    failures++;
    console.error("FAIL: exception", e);
}
for (const u of users) {
    try { await u.rpc("ACCOUNT_DELETE_REQUEST"); } catch (e) { /* best effort */ }
    try { u.socket.disconnect(false); } catch (e) { /* ignore */ }
}
try {
    const since = Math.floor(T0.getTime() / 1000) - 1;
    const log = execSync(`${CONTAINER_CLI} logs --since ${since} ${CONTAINER} 2>&1`, { encoding: "utf8", maxBuffer: 64 << 20 });
    const errs = log.split("\n").filter((l) => /"level":"error"/.test(l));
    for (const l of errs) console.error("SERVER ERROR:", l.slice(0, 400));
    ok(errs.length === 0, "server log free of errors");
    console.log("referee log lines: " + log.split("\n").filter((l) => l.includes("referee:")).length);
} catch (e) {
    console.log("(server log check skipped: " + e.message.split("\n")[0] + ")");
}
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
