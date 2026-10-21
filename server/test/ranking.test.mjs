// Ranking test: npm run test:ranking (server must be running). Plays scripted 2-player games (CreateChallenge -> GAME_WON, no matchmaker)
// and queries every leaderboard / season / bracket endpoint. Contract: docs/protocol/economy-ranking.md sec 3, 10-14
import { Client } from "@heroiclabs/nakama-js";
import { execSync } from "node:child_process";
import { HOSTNAME, PORT, SSL, SERVER_KEY, CONTAINER, CONTAINER_CLI } from "./env.mjs";

const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const RUN = Date.now().toString(36);
const T0 = new Date();
const called = new Set();
let failures = 0, passes = 0, reqN = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.error("FAIL:", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPS = ["CatanBaseGame", "CatanSeafarer", "CatanCitiesAndKnights", "RivalsBaseGame", "RivalsAgeOfDarkness", "RivalsAgeOfEnlightenment", "CatanArrivalAtCatan", "CatanRiseOfTheInkas", "RivalsAgeOfEnlightenment_EOE", "CatanExplorers", "RivalsAgeOfDarkness_EOB", "CatanBigGame"];
const LB = "PLAYER_ELO_RANKING.EXPANSION.";
const users = []; // deleted at the end (ACCOUNT_DELETE_REQUEST) so test players never stay on the leaderboards

async function mkUser(tag) {
    const session = await client.authenticateDevice(`rk-test-${tag}-${RUN}`, true, `rk${tag}${RUN}`);
    const socket = client.createSocket(SSL, false);
    const u = { tag, session, id: session.user_id, pushes: [], name: `Rk${tag}${RUN}` };
    socket.onnotification = (n) => u.pushes.push(typeof n.content === "string" ? JSON.parse(n.content) : n.content);
    await socket.connect(session, true);
    u.socket = socket;
    users.push(u);
    u.rpc = async (id, fields = {}) => {
        called.add(id);
        // communitanCaps: the mod's capability token; required by CATAN_SERVER_RNG=full servers, ignored otherwise (mp_rng.ts)
        const req = { requestId: `${Date.now()}_${++reqN}`, communitanCaps: "rng-full-1", ...fields };
        if (id.endsWith("Request")) req["@class"] = "." + id; else { req["@class"] = ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
        if (p.requestId !== req.requestId) throw new Error(`${id}: requestId not echoed`);
        return p;
    };
    await u.rpc("ChangeUserDetailsRequest", { displayName: u.name });
    return u;
}
const sd = (r) => r.scriptData || {};
const err = (r) => (r.error ? r.error.errorCode : 0);
const rowKeys = ["userId", "userName", "rank", "ELO", "INCREASE", "HASFINISHED"];
const rowOk = (r) => rowKeys.every((k) => k in r) && typeof r.ELO === "number" && Number.isInteger(r.INCREASE);

async function game(winner, loser, { season = false, mt = "QUICK_MATCH" } = {}) {
    const id = crypto.randomUUID();
    const gi = { matchType: mt, expansions: ["CatanBaseGame"], scenarios: ["S"], minPlayers: 2, maxPlayers: 2, isSeason: season, sortedPlayerIds: [winner.id, loser.id] };
    await winner.rpc("CreateChallengeRequest", { challengeShortCode: "CATAN", minPlayers: 2, maxPlayers: 2, usersToChallenge: [loser.id], scriptData: { challengeInstanceId: id, seed: 1, colorSeed: 2, diceSeed: 3, gameInfo: gi } });
    await winner.rpc("GAME_WON", { CHALLENGE_ID: id, WON: 1, EXPANSION: "CatanBaseGame", SINGLEPLAYER: 0, WIN_LOSE: { win_lose: [{ playerId: winner.id, rank: 1, victorypoints: 10 }, { playerId: loser.id, rank: 2, victorypoints: 5 }] } });
    for (let i = 0; i < 50; i++) {
        const m = winner.pushes.findIndex((p) => p.extCode === "GAME_MULTIPLAYER_RESULT" && p.data.challengeId === id);
        if (m >= 0) return winner.pushes.splice(m, 1)[0].data;
        await sleep(100);
    }
    return null;
}
async function push(u, ext, ms = 3000) {
    for (let t = 0; t < ms; t += 50) {
        const i = u.pushes.findIndex((m) => m.extCode === ext);
        if (i >= 0) return u.pushes.splice(i, 1)[0];
        await sleep(50);
    }
    return null;
}

async function main() {
    const [A, B, C] = [await mkUser("a"), await mkUser("b"), await mkUser("c")];
    await A.rpc("FRIEND_REQUEST_FRIENDSHIP", { USER_ID: B.id });
    await B.rpc("FRIEND_ACCEPT_FRIENDSHIP", { USER_ID: A.id });
    const gname = `RkGuild${RUN}`;
    const gd = sd(await A.rpc("GUILD_CREATE", { GUILD_NAME: gname, GUILD_DESCRIPTION: "d", GUILD_MESSAGE_OF_THE_DAY: "m" })).guildData;
    ok(gd, "guild created");
    const D = await mkUser("d"); // guild member, not a friend: part of A's "friends and guild" view
    await D.rpc("GUILD_JOIN_REQUEST", { GUILD_ID: gd.guildId || gd.id });
    ok(!(await A.rpc("GUILD_ACCEPT_ASPIRANT", { PLAYER_ID: D.id })).error, "guild member joined");

    console.log("== static");
    let r = await A.rpc("LEADERBOARD_GET_BRACKETS");
    ok(JSON.stringify(sd(r).brackets) === "[1,5,25,45,85]", "brackets (PROD values)");
    for (const e of EXPS) {
        r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + e, entryCount: 5, offset: 0, social: false, dontErrorOnNotSocial: true });
        ok(r["@class"] === ".LeaderboardDataResponse" && Array.isArray(r.data) && Number.isInteger(sd(r).entryCount), "LeaderboardData shape " + e);
    }
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: "GUILD_ELO_RANKING", entryCount: 5, offset: 0 });
    ok(Array.isArray(r.data), "guild lb exists");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: "TOURNAMENT_AUTO.TOURNAMENT_ID.x", entryCount: 5 });
    ok(err(r) === 36, "unknown lb -> LeaderboardDoesntExist(36)");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "Nope", entryCount: 5 });
    ok(err(r) === 36, "unknown expansion -> 36");
    r = await A.rpc("LEADERBOARD_FIND_RANKS_FOR_PLAYERNAMES", { PLAYERNAME: A.name, EXPANSION: "CatanBaseGame" });
    ok(Array.isArray(sd(r).leaderboard) && "entryCount" in sd(r), "FIND_RANKS_FOR_PLAYERNAMES shape (no record yet)");
    r = await A.rpc("LEADERBOARD_FIND_RANKS_FOR_FRIENDS_LEADERBOARD", { EXPANSION: "CatanBaseGame" });
    ok(Array.isArray(sd(r).leaderboard) && "entryCount" in sd(r), "FIND_RANKS_FOR_FRIENDS shape");
    // unranked own entry: never empty (client NRE, LeaderboardScreen.cs:129) -> placeholder without userId
    r = await A.rpc("LeaderboardsEntriesRequest", { player: A.id, leaderboards: [LB + "CatanBaseGame"] });
    let pe = (r[LB + "CatanBaseGame"] || [])[0];
    ok(!r.error && pe && pe.userId === "" && pe.rank === 0 && pe.gamesPlayed === 0 && "entryCount" in sd(r), "LeaderboardsEntries unranked placeholder");
    r = await A.rpc("LeaderboardsEntriesRequest", { player: A.id, leaderboards: [LB + "Nope"] });
    pe = (r[LB + "Nope"] || [])[0];
    ok(!r.error && pe && pe.userId === "", "LeaderboardsEntries unknown expansion -> placeholder, no error");
    r = await A.rpc("LeaderboardsEntriesRequest", { player: A.id, leaderboards: ["TOURNAMENT_AUTO.TOURNAMENT_ID.x"] });
    ok(!r.error && Array.isArray(r["TOURNAMENT_AUTO.TOURNAMENT_ID.x"]) && r["TOURNAMENT_AUTO.TOURNAMENT_ID.x"].length === 0, "LeaderboardsEntries tournament -> []");
    r = await A.rpc("LEADERBOARD_GET_BRACKETS_BY_ID", { PLAYER_ID: A.id });
    ok(Array.isArray(sd(r).brackets) && Array.isArray(sd(r).rankPercentages), "BRACKETS_BY_ID shape");
    for (const id of ["TOURNAMENT_GET_CONFIG", "TOURNAMENT_GET_LIST", "TOURNAMENT_GET_MY_LIST", "TOURNAMENT_GET_PARTICIPANTS", "TOURNAMENT_GET_GAME_RESULTS"]) ok(!(await A.rpc(id)).error, id);
    ok(sd(await A.rpc("TOURNAMENT_GET_CONFIG")).tournamentConfig.isFeatureEnabled === false, "tournaments disabled");

    console.log("== seasons");
    r = await A.rpc("SEASON_GET_SEASONS_DETAILS");
    const s1 = sd(r).seasons.find((s) => s.id === "Season1");
    ok(s1 && s1.state === "RUNNING" && s1.isLocalPlayerParticipant === false && s1.placementMatches === 3 && s1.reward1.percentage > 0 && Array.isArray(s1.reward1.products), "season details RUNNING");
    ok(!s1.myRank && s1.leaderboardCount >= 0, "no myRank before join");
    const n0 = s1.leaderboardCount; // season state persists across runs
    ok(err(await A.rpc("SEASON_JOIN", { SEASON_ID: "Nope", PAYMENT: 1 })) === 48, "join unknown season -> 48");
    for (const u of [A, B]) ok(!(await u.rpc("SEASON_JOIN", { SEASON_ID: "Season1", PAYMENT: 1 })).error, "SEASON_JOIN " + u.tag);
    ok(!(await A.rpc("SEASON_JOIN", { SEASON_ID: "Season1", PAYMENT: 1 })).error, "SEASON_JOIN idempotent");
    r = await A.rpc("SEASON_GET_SEASONS_DETAILS");
    const s1b = sd(r).seasons.find((s) => s.id === "Season1");
    ok(s1b.isLocalPlayerParticipant && s1b.leaderboardCount === n0 + 2 && s1b.myRank && s1b.myRank.ELO === 1e9 && s1b.myRank.HASFINISHED === false && s1b.myPlacementMatches === 0, "participant + myRank after join");

    console.log("== games");
    const g1 = await game(A, B, { season: true });
    ok(g1, "game 1 result");
    const a1 = g1.win_lose.find((x) => x.playerId === A.id), b1 = g1.win_lose.find((x) => x.playerId === B.id);
    ok(a1.increaseElo > 0 && b1.increaseElo < 0 && a1.xpEarned === 100 && a1.isSeasonParticipant && a1.seasonEloBefore === 1000 && a1.increaseSeasonElo === a1.increaseElo && a1.seasonPlacementMatches === 1, "result rows + season fields");
    const g2 = await game(A, C, { season: true });
    ok(g2 && !g2.win_lose.find((x) => x.playerId === C.id).isSeasonParticipant, "non-participant has no season fields");
    const g3 = await game(B, C, { mt: "CUSTOM_MATCH" });
    ok(g3 && g3.win_lose.every((x) => x.increaseElo === 0), "custom match unranked");
    const gd1 = await game(D, C);
    ok(gd1, "guild member D ranked game");
    const incD = gd1 ? gd1.win_lose.find((x) => x.playerId === D.id).increaseElo : 0;
    const eloA = 1000 + a1.increaseElo + g2.win_lose.find((x) => x.playerId === A.id).increaseElo;

    console.log("== queries");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 100, offset: 0, social: false });
    const mine = r.data.find((x) => x.userId === A.id);
    ok(r.data.length >= 3 && sd(r).entryCount === r.data.length && r.data.every(rowOk), "global rows");
    ok(mine && mine.rank === r.data.findIndex((x) => x.userId === A.id) + 1 && mine.ELO === eloA * 1e6 && mine.INCREASE === 2 && mine.userName === A.name, "A row: ELO=elo*1e6, games, name");
    ok(r.data.every((x, i) => i === 0 || x.ELO <= r.data[i - 1].ELO), "sorted by ELO desc");
    const off = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 1, offset: 1 });
    ok(off.data.length === 1 && off.data[0].userId === r.data[1].userId && sd(off).entryCount === r.data.length, "offset paging");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 100, offset: 0, social: true });
    const total = sd(off).entryCount;
    const glob = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 100, offset: 0 });
    const gRank = (id) => (glob.data.find((x) => x.userId === id) || {}).rank;
    ok(r.data.length === glob.data.length && sd(r).entryCount === total, "social ignored on LeaderboardData (client never resets its friends flag)");
    r = await A.rpc("LeaderboardsEntriesRequest", { player: A.id, leaderboards: [LB + "CatanBaseGame"] });
    const e = r[LB + "CatanBaseGame"][0];
    ok(e && e.score === eloA * 1e6 && e.gamesPlayed === 2 && e.rank >= 1 && e.userId === A.id && sd(r).entryCount >= 3, "LeaderboardsEntries own entry");
    r = await A.rpc("AroundMeLeaderboardRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 3 });
    ok(r.data.some((x) => x.userId === A.id) && r.data.every(rowOk), "around me");
    r = await A.rpc("LEADERBOARD_FIND_RANKS_FOR_PLAYERNAMES", { PLAYERNAME: `Rk`, EXPANSION: "CatanBaseGame" });
    ok(sd(r).leaderboard.length >= 3 && sd(r).leaderboard.every(rowOk) && sd(r).entryCount >= 3, "FIND_RANKS_FOR_PLAYERNAMES prefix");
    const topRk = Math.min(...glob.data.filter((x) => x.userName.startsWith("Rk")).map((x) => x.rank));
    ok(sd(r).leaderboard[0].rank === topRk && sd(r).leaderboard.every((x, i) => i === 0 || x.rank >= sd(r).leaderboard[i - 1].rank), "name search: best ranked first");
    r = await A.rpc("LEADERBOARD_FIND_RANKS_FOR_PLAYERNAMES", { PLAYERNAME: B.name.toLowerCase(), EXPANSION: "CatanBaseGame" });
    ok(sd(r).leaderboard.length === 1 && sd(r).leaderboard[0].userId === B.id, "FIND_RANKS_FOR_PLAYERNAMES exact (case-insensitive)");
    r = await A.rpc("LEADERBOARD_FIND_RANKS_FOR_FRIENDS_LEADERBOARD", { EXPANSION: "CatanBaseGame" });
    ok(sd(r).leaderboard.map((x) => x.userId).sort().join() === [A.id, B.id, D.id].sort().join() && sd(r).leaderboard.every((x) => x.rank === gRank(x.userId)) && sd(r).entryCount === total, "FIND_RANKS_FOR_FRIENDS global ranks");
    r = await A.rpc("LEADERBOARD_GET_BRACKETS_BY_ID", { PLAYER_ID: A.id });
    ok(sd(r).rankPercentages.length === 0, "BRACKETS_BY_ID: no bracket during placement (2/5 games)");
    r = await A.rpc("SEASON_GET_LEADERBOARD_FOR_PLAYERNAME", { SEASON_ID: "Season1", PLAYERNAME: A.id, ENTRY_COUNT: 1 });
    ok(sd(r).leaderboard.length === 1 && sd(r).leaderboard[0].userId === A.id, "PLAYERNAME = user id (profile season ELO)");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: "GUILD_ELO_RANKING", entryCount: 500, offset: 0, social: false });
    const gr = r.data.find((x) => x.teamName === gname);
    ok(gr && gr["LAST-ELO"] === (eloA + incD) * 1e6, "guild ELO = 1000 + member increases");
    ok(gr && gr["SUM-COUNT"] === 3 && gr.teamId && gr.rank >= 1, "guild row keys (teamId, SUM-COUNT)");
    r = await A.rpc("GUILD_GET_ELO_SORTED_LIST");
    ok(!r.error, "GUILD_GET_ELO_SORTED_LIST");

    console.log("== account (single source)");
    const soloReq = `solo_${RUN}`;
    for (let i = 0; i < 2; i++) await A.rpc("GAME_WON", { requestId: soloReq, CHALLENGE_ID: "", WON: 1, EXPANSION: "CatanSeafarer", MAP: "M1", SINGLEPLAYER: 1 });
    await A.rpc("GAME_WON", { CHALLENGE_ID: "", WON: 0, EXPANSION: "CatanSeafarer", MAP: "M1", SINGLEPLAYER: 1 });
    r = await A.rpc("AccountDetailsRequest");
    const stx = sd(r).statistics || {};
    const won = (exp, sp) => (stx.gamesWon || []).find((x) => x.keys.EXPANSION === exp && x.keys.SINGLEPLAYER === sp);
    ok(won("CatanBaseGame", 0) && won("CatanBaseGame", 0)["SUM-COUNT"] === 2, "statistics: multiplayer wins per expansion");
    ok(won("CatanSeafarer", 1) && won("CatanSeafarer", 1)["SUM-COUNT"] === 1, "statistics: singleplayer win counted once (durable retry)");
    const played = (k, list, key) => ((stx[list] || []).find((x) => x.keys[key] === k) || {})["COUNT-WON"];
    ok(played("CatanBaseGame", "mostPlayedExpansions", "EXPANSION") === 2 && played("CatanSeafarer", "mostPlayedExpansions", "EXPANSION") === 2, "statistics: games per expansion");
    ok(played("S", "mostPlayedMaps", "MAP") === 2 && played("M1", "mostPlayedMaps", "MAP") === 2, "statistics: games per map");
    ok((await B.rpc("ACCOUNT_GET_DETAILS_BY_ID", { PLAYER_ID: A.id })).scriptData.statistics.gamesWon.length === 2, "statistics in other players' details");
    ok(Object.keys(sd(r).elo).join() === "CatanBaseGame", "elo only for played expansions");
    ok(sd(r).elo.CatanBaseGame === eloA && sd(r).eloPlacement.CatanBaseGame === 2 && sd(r).level === 25 && sd(r).xpForThisLevel === 200 && sd(r).xpFromThisLevelToNext === 600, "AccountDetails elo/xp/level from mp_stats");
    r = await B.rpc("ACCOUNT_GET_DETAILS_BY_ID", { PLAYER_ID: A.id });
    ok(sd(r).elo.CatanBaseGame === eloA, "by-id elo");

    console.log("== season queries");
    r = await A.rpc("SEASON_GET_SEASONS_DETAILS");
    const s1c = sd(r).seasons.find((s) => s.id === "Season1");
    ok(s1c.leaderboardCount === n0 + 2 && s1c.myPlacementMatches === 2 && s1c.myRank.rank >= 1 && s1c.myRank.COUNT === 2 && s1c.myRank.ELO === (1000 + a1.increaseElo + g2.win_lose.find((x) => x.playerId === A.id).increaseElo) * 1e6, "season details after games");
    r = await A.rpc("SEASON_GET_LEADERBOARD", { SEASON_ID: "Season1", OFFSET: 0, COUNT: 1000 });
    const sa = sd(r).leaderboard.find((x) => x.userId === A.id), sb = sd(r).leaderboard.find((x) => x.userId === B.id);
    ok(sd(r).leaderboardCount === n0 + 2 && sd(r).leaderboard.length === n0 + 2 && sa && sb && sa.rank < sb.rank && sd(r).leaderboard.every(rowOk) && sa.COUNT === 2, "SEASON_GET_LEADERBOARD");
    r = await A.rpc("SEASON_GET_LEADERBOARD_FOR_PLAYERNAME", { SEASON_ID: "Season1", PLAYERNAME: B.name, ENTRY_COUNT: 5 });
    ok(sd(r).leaderboard.length === 1 && sd(r).leaderboard[0].userId === B.id && sd(r).leaderboard[0].rank === sb.rank, "SEASON_GET_LEADERBOARD_FOR_PLAYERNAME");
    r = await A.rpc("SEASON_GET_PARTICIPANTS", { SEASON_ID: "Season1", OFFSET: 0, COUNT: 1000 });
    ok(sd(r).participants.length === n0 + 2 && sd(r).participants.some((p) => p.userId === B.id) && sd(r).participants.every((p) => p.userId && p.displayName !== undefined), "SEASON_GET_PARTICIPANTS");
    r = await A.rpc("SEASON_GET_PARTICIPANTS_WITH_PLAYERNAME", { SEASON_ID: "Season1", PLAYERNAME: A.name, ENTRIES_COUNT: 5 });
    ok(sd(r).participants.length === 1 && sd(r).participants[0].userId === A.id, "SEASON_GET_PARTICIPANTS_WITH_PLAYERNAME");
    r = await A.rpc("SEASON_PLAYER_HAS_FINISHED", { SEASON_ID: "Season1" });
    ok(!r.error && Object.keys(sd(r)).length === 0, "HAS_FINISHED while running -> {}");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: "SEASON_ELO_RANKING.Season1", entryCount: 10 });
    ok(sd(r).entryCount === n0 + 2 && r.data.length === Math.min(10, n0 + 2), "season lb via LeaderboardData");

    console.log("== level progress");
    A.pushes.length = 0;
    let lp = null;
    for (let i = 0; i < 8 && !lp; i++) { await game(A, B); lp = A.pushes.find((p) => p.extCode === "LEVEL_PROGRESS"); }
    ok(lp && lp.data.level === 26 && lp.data.tickets === 0, "LEVEL_PROGRESS push when XP crosses a level");
    r = await A.rpc("AccountDetailsRequest");
    ok(sd(r).level === 26 && sd(r).xpFromThisLevelToNext === 620, "level 26 in account details");

    console.log("== brackets after placement, rename");
    r = await A.rpc("LEADERBOARD_GET_BRACKETS_BY_ID", { PLAYER_ID: A.id });
    const own = (await A.rpc("LeaderboardsEntriesRequest", { player: A.id, leaderboards: [LB + "CatanBaseGame"] }));
    const ownRow = own[LB + "CatanBaseGame"][0];
    const bp = sd(r).rankPercentages.find((x) => x.expansion === "CatanBaseGame");
    ok(bp && bp.rankPercentage === Math.floor(ownRow.rank * 100 / sd(own).entryCount), "BRACKETS_BY_ID = floor(rank*100/total), as the client's list");
    const renamed = `RkRen${RUN}`;
    ok(!(await B.rpc("ChangeUserDetailsRequest", { displayName: renamed })).error, "rename");
    r = await A.rpc("LeaderboardDataRequest", { leaderboardShortCode: LB + "CatanBaseGame", entryCount: 100, offset: 0 });
    ok((r.data.find((x) => x.userId === B.id) || {}).userName === renamed, "leaderboard shows the new name");
    r = await A.rpc("SEASON_GET_LEADERBOARD", { SEASON_ID: "Season1", OFFSET: 0, COUNT: 1000 });
    ok((sd(r).leaderboard.find((x) => x.userId === B.id) || {}).userName === renamed, "season leaderboard shows the new name");
}

function serverErrors() {
    try {
        const since = Math.floor(T0.getTime() / 1000) - 1;
        const log = execSync(`${CONTAINER_CLI} logs --since ${since} ${CONTAINER} 2>&1`, { encoding: "utf8", maxBuffer: 64 << 20 });
        return log.split("\n").filter((l) => /"level":"error"/.test(l) && ([...called].some((id) => l.toLowerCase().includes(id.toLowerCase())) || /rankingRecord/.test(l)));
    } catch (e) {
        console.log("(server log check skipped: " + e.message.split("\n")[0] + ")");
        return [];
    }
}

async function cleanup() {
    for (const u of users) {
        try { await u.rpc("ACCOUNT_DELETE_REQUEST"); } catch (e) { console.error("cleanup", u.tag, e.message || e); }
        try { u.socket.disconnect(false); } catch (e) { /* gone */ }
    }
    const left = await client.authenticateDevice(`rk-test-check-${RUN}`, true);
    const r = await client.rpc(left, "LeaderboardDataRequest", { "@class": ".LeaderboardDataRequest", requestId: "x", leaderboardShortCode: LB + "CatanBaseGame", entryCount: 1000, offset: 0 });
    const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    ok(!(p.data || []).some((x) => users.some((u) => u.id === x.userId)), "test players removed from the leaderboard");
    await client.rpc(left, "ACCOUNT_DELETE_REQUEST", { "@class": ".LogEventRequest", eventKey: "ACCOUNT_DELETE_REQUEST", requestId: "y" });
}

try { await main(); } catch (e) { failures++; console.error("FAIL: exception", e); }
try { await cleanup(); } catch (e) { failures++; console.error("FAIL: cleanup", e); }
const errs = serverErrors();
for (const l of errs) console.error("SERVER LOG:", l);
ok(errs.length === 0, "server log free of errors");
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
