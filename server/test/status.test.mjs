// Public status test: npm run test:status (server must be running). RPC COMMUNITAN_STATUS via http_key (no session) and
// via a GS LogEventRequest; searching (matchmaker add/remove/matched/disconnect), online and playing counts per mode key;
// http_key calls to any other RPC are refused. Contract: docs/protocol/core.md 5.4
import { Client } from "@heroiclabs/nakama-js";
import { BASE, HOSTNAME, PORT, SSL, SERVER_KEY, HTTP_KEY } from "./env.mjs";

const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const RUN = Date.now().toString(36);
let failures = 0, passes = 0, reqN = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.error("FAIL:", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Status is cached per VM for 2 s.
const CACHE_MS = 2200;

async function status() {
    const r = await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`);
    return r.ok ? r.json() : { httpStatus: r.status };
}
const mode = (s, key) => (s.modes && s.modes[key]) || { searching: 0, playing: 0 };

async function mkUser(tag) {
    const session = await client.authenticateDevice(`st-test-${tag}-${RUN}`, true, `st${tag}${RUN}`);
    const socket = client.createSocket(SSL, false);
    const u = { tag, session, socket, id: session.user_id, matched: null };
    socket.onmatchmakermatched = (m) => { u.matched = m; };
    await socket.connect(session, true);
    u.rpc = async (id, fields = {}) => {
        // communitanCaps: the mod's capability token; required by CATAN_SERVER_RNG=full servers, ignored otherwise (mp_rng.ts)
        const req = { requestId: `${Date.now()}_${++reqN}`, communitanCaps: "rng-full-1", ...fields };
        if (id.endsWith("Request")) req["@class"] = "." + id; else { req["@class"] = ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        return typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    };
    await u.rpc("ACCOUNT_GET_BALANCE"); // any authenticated RPC marks the user as an online candidate
    return u;
}

async function main() {
    console.log("== public endpoint");
    let s = await status();
    ok(typeof s.online === "number" && typeof s.playing === "number" && typeof s.searching === "number" && typeof s.modes === "object" && ["off", "seeds", "full"].includes(s.rng) && ["off", "audit", "enforce"].includes(s.rules), "GET unwrap returns counts: " + JSON.stringify(s));
    let r = await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: "POST", body: "" });
    ok(r.ok && typeof (await r.json()).online === "number", "POST unwrap (empty body) works");
    r = await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=wrong-key&unwrap`);
    ok(r.status === 401, "wrong http_key -> 401");
    for (const id of ["ACCOUNT_GET_BALANCE", "AccountDetailsRequest", "GAME_GET_CURRENT_SESSION"]) {
        const body = id.endsWith("Request") ? { "@class": "." + id, requestId: "x" } : { "@class": ".LogEventRequest", eventKey: id, requestId: "x" };
        r = await fetch(`${BASE}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: "POST", body: JSON.stringify(body) });
        const p = r.ok ? await r.json() : {};
        ok(p.error && p.error.code === "UNAUTHORIZED" && !p.scriptData, `http_key call to ${id} refused: ${JSON.stringify(p)}`);
    }

    console.log("== online + searching");
    const base = await status();
    const [a, b] = [await mkUser("a"), await mkUser("b")];
    r = await a.rpc("COMMUNITAN_STATUS");
    ok(r["@class"] === ".LogEventResponse" && r.scriptData && typeof r.scriptData.online === "number", "GS LogEventRequest COMMUNITAN_STATUS -> scriptData");
    await sleep(CACHE_MS);
    s = await status();
    ok(s.online >= base.online + 2, `online +2 (${base.online} -> ${s.online})`);

    // Same mode for both, queries that never match each other (min 3 so no match either).
    const exp = `TestExp${RUN}`;
    const key = `QUICK_MATCH|CatanBaseGame,${exp}|3-3`;
    const tickets = {};
    for (const u of [a, b]) {
        const t = await u.socket.addMatchmaker(`+properties.stself:${u.tag}${RUN}`, 3, 3, { stself: `${u.tag}${RUN}`, matchType: "QUICK_MATCH", expansions: `${exp} CatanBaseGame` }, { skill: 1000 });
        tickets[u.tag] = t.ticket;
    }
    await sleep(CACHE_MS);
    s = await status();
    ok(mode(s, key).searching === 2, `searching 2 for ${key}: ${JSON.stringify(s.modes)}`);
    ok(s.searching >= base.searching + 2, "total searching +2");
    await a.socket.removeMatchmaker(tickets.a);
    await sleep(CACHE_MS);
    s = await status();
    ok(mode(s, key).searching === 1, "searching 1 after remove");
    b.socket.disconnect(false);
    await sleep(CACHE_MS + 500);
    s = await status();
    ok(mode(s, key).searching === 0, "searching 0 after the searcher disconnected");
    ok(s.online === base.online + 1, `online -1 after disconnect (${base.online} + 1 vs ${s.online})`);

    console.log("== matched clears searching (default relayed match still works)");
    const [c, d] = [await mkUser("c"), await mkUser("d")];
    const key2 = `AUTO_MATCH|${exp}|2-2`;
    for (const u of [c, d]) await u.socket.addMatchmaker(`+properties.stpair:${RUN}`, 2, 2, { stpair: RUN, matchType: "AUTO_MATCH", expansions: exp }, { skill: 1000 });
    const end = Date.now() + 30000;
    while ((!c.matched || !d.matched) && Date.now() < end) await sleep(200);
    ok(c.matched && d.matched, "matchmaker matched");
    if (c.matched && d.matched) {
        ok(!c.matched.match_id && !!c.matched.token, "relayed match (token, no authoritative match id)");
        const m1 = await c.socket.joinMatch(undefined, c.matched.token);
        const m2 = await d.socket.joinMatch(undefined, d.matched.token);
        ok(m1.match_id && m1.match_id === m2.match_id, "token join works");
        await sleep(CACHE_MS);
        s = await status();
        ok(mode(s, key2).searching === 0, "searching 0 after matched");

        console.log("== playing");
        const gi = { matchType: "AUTO_MATCH", expansions: [exp], scenarios: ["x"], minPlayers: 2, maxPlayers: 2, sortedPlayerIds: [c.id, d.id] };
        r = await c.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", usersToChallenge: [d.id], scriptData: { challengeInstanceId: m1.match_id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: gi } });
        ok(!r.error, "CreateChallenge");
        await sleep(CACHE_MS);
        s = await status();
        ok(mode(s, key2).playing === 2, `playing 2 for ${key2}: ${JSON.stringify(s.modes[key2])}`);
        ok(s.playing >= base.playing + 2, "total playing +2");
        for (const u of [c, d]) await u.rpc("GAME_EXIT_SESSION", { REASON: "test" });
        await sleep(CACHE_MS);
        s = await status();
        ok(mode(s, key2).playing === 0, "playing 0 after both exited");
    }
    for (const u of [a, c, d]) u.socket.disconnect(false);
}

try { await main(); } catch (e) { failures++; console.error("FAIL: exception", e); }
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
