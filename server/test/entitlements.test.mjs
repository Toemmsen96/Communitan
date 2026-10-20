// Entitlements test: npm run test:entitlements (server must be running). Checks the server's mode, read from the public
// status (CATAN_ENTITLEMENTS=free|owned, CATAN_DEV_UNLOCK_ALL=1 -> "dev"): fresh-account shape, shop/catalog flags,
// suns, COMMUNITAN_ENTITLEMENTS_CLAIM validation + binding + mask/catalog filtering (owned), legacy maxed profiles (needs the
// console: NAKAMA_CONSOLE, CONSOLE_USERNAME, CONSOLE_PASSWORD). Run it once per mode. Contract: economy-ranking.md sec 2a.
import { createHash } from "node:crypto";
import { Client } from "@heroiclabs/nakama-js";
import { BASE, HOSTNAME, PORT, SSL, SERVER_KEY, HTTP_KEY } from "./env.mjs";

const client = new Client(SERVER_KEY, HOSTNAME, PORT, SSL);
const CONSOLE = process.env.NAKAMA_CONSOLE || "http://127.0.0.1:7351";
const RUN = Date.now().toString(36);
let failures = 0, passes = 0, reqN = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.error("FAIL:", msg); } };
const HASH = (c) => c.repeat(64);

async function mkUser(tag) {
    const session = await client.authenticateDevice(`ent-test-${tag}-${RUN}`, true, `ent${tag}${RUN}`);
    const u = { tag, session, id: session.user_id };
    u.rpc = async (id, fields = {}) => {
        const req = { requestId: `${Date.now()}_${++reqN}`, communitanCaps: "rng-full-1", ...fields };
        if (id.endsWith("Request")) req["@class"] = "." + id; else { req["@class"] = ".LogEventRequest"; req.eventKey = id; }
        const r = await client.rpc(session, id, req);
        return typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    };
    u.details = async () => (await u.rpc("AccountDetailsRequest"));
    u.claim = async (f) => u.rpc("COMMUNITAN_ENTITLEMENTS_CLAIM", { expansions: 0, items: [], officialUserHash: HASH("a"), capturedAt: new Date().toISOString(), ...f });
    await u.rpc("ACCOUNT_LOGIN", { AUTHENTICATION_TYPE: "Device" });
    return u;
}
const errCode = (r) => r.error && (r.error.code || r.error.errorCode);
const byId = (list, id) => list.find((x) => x.ID === id) || {};

async function consoleToken() {
    const r = await fetch(`${CONSOLE}/v2/console/authenticate`, { method: "POST", body: JSON.stringify({ username: process.env.CONSOLE_USERNAME || "admin", password: process.env.CONSOLE_PASSWORD || "catanadmin" }) });
    return r.ok ? (await r.json()).token : null;
}

// A profile written by the old "everything unlocked" server: maxed wallet + suns, no entV marker.
async function legacyProfile(u) {
    const t = await consoleToken();
    if (!t) { console.log("(legacy profile check skipped: console not reachable)"); return false; }
    const h = { Authorization: `Bearer ${t}` };
    const url = `${CONSOLE}/v2/console/storage/profile/main/${u.id}`;
    const cur = await (await fetch(url, { headers: h })).json();
    const v = JSON.parse(cur.value);
    v.currency1 = 99999; v.currency2 = 999; v.suns = { permanent: 2, temporary: 99, reloadTimes: [] }; delete v.entV;
    const w = await fetch(url, { method: "PUT", headers: h, body: JSON.stringify({ value: JSON.stringify(v), permission_read: 1, permission_write: 0 }) });
    return w.ok;
}

async function commonFresh(u, mode) {
    const r = await u.details();
    const sd = r.scriptData || {};
    const vg = sd.virtualGoods || {};
    if (mode === "dev") {
        ok(sd.expansions === 131071 && r.currency1 === 99999 && vg.CatanSeafarer && vg.ITEM_PET_DRAGON, "dev: everything unlocked");
        return;
    }
    ok(sd.expansions === 0 && sd.expansionsViaPromoFlag === 0, `${mode}: fresh expansions 0 (${sd.expansions})`);
    ok(r.currency1 === 0 && sd.currency1 === 0 && sd.currency2 === 0 && sd.scrollsEnabled === false, `${mode}: wallet 0, scrolls off`);
    ok(sd.suns && sd.suns.permanent === 1 && sd.suns.temporary === 0 && sd.suns.reloadTimes.length === 0, `${mode}: suns like PROD ` + JSON.stringify(sd.suns));
    ok(vg.ITEM_MALE_HAIR1 && vg.BOARD_TABLE_BASE && vg.COLOR_PLAYER_PURPLE && vg.COLLECTION_BASE1, `${mode}: starter goods`);
    ok(!vg.CatanBaseGame && !vg.ITEM_PET_DRAGON && !vg.COLLECTION_VIKING && !vg.BOARD_PIECE_VIKING, `${mode}: no paid goods`);
    ok(vg.ITEM_MALE_CLOTH2 && vg.COLOR_TURQUOISE, `${mode}: level rewards (level ${sd.level}) owned`);

    const items = (await u.rpc("ITEM_GET_PRODUCT_ITEMS", { CATEGORIES: ["Color", "Item", "BoardTable", "BoardPieces", "BoardTile"] })).scriptData;
    const dragon = byId(items.Item, "ITEM_PET_DRAGON"), hair = byId(items.Item, "ITEM_MALE_HAIR1");
    ok(dragon.AlreadyBought === false && dragon.IsPurchasable === false && dragon.ConditionText && hair.AlreadyBought === true, `${mode}: item flags per player`);
    const shop = (await u.rpc("SHOP_PRODUCTS_FOR_CATEGORIES", { CATEGORIES: ["Expansion", "Bundle", "Coins", "AvatarCollection"] })).scriptData;
    ok(shop.Expansion.length > 0 && shop.Expansion.every((p) => !p.AlreadyBought && !p.IsPurchasable), `${mode}: expansions not owned, not purchasable`);
    ok(Object.keys(shop).every((k) => shop[k].every((p) => p.IsPurchasable === false)), `${mode}: nothing purchasable`);
    ok((await u.rpc("SHOP_GET_EXTERNAL_PRODUCTS")).scriptData.products.length === 0, `${mode}: no real-money products`);
    ok((await u.rpc("PAYMENT_GET_STEAM_PRODUCT_PRICE", { PRODUCT_ID_LIST: "cu_coins_v2_200" })).scriptData.result.length === 0, `${mode}: no Steam prices`);
    ok(errCode(await u.rpc("SHOP_BUY_OFFER", { OFFERCODE: "CatanSeafarer" })) === 48, `${mode}: buy refused`);
    ok(errCode(await u.rpc("TICKET_UNLOCK_EXPANSION", { EXPANSION: "CatanSeafarer" })) === 48, `${mode}: ticket unlock refused`);
    const eq = (await u.rpc("ITEM_EQUIP_ITEM", { ITEM_ID: "ITEM_PET_DRAGON", CATEGORY: "Species", COLOR_ID: "", TIMESTAMP: 1 })).scriptData;
    ok(!eq.equipmentItems.Species, `${mode}: equipping a not-owned item is ignored`);

    let s = await u.rpc("ACCOUNT_USE_SUN", { GAME_INFO: {} });
    ok(!s.error && s.scriptData.suns.reloadTimes.length === 1 && Date.parse(s.scriptData.suns.reloadTimes[0]) > Date.now() + 3600e3, `${mode}: sun used, reloading`);
    s = await u.rpc("ACCOUNT_USE_SUN", { GAME_INFO: {} });
    ok(errCode(s) === 48, `${mode}: no second sun`);
    ok((await u.details()).scriptData.suns.reloadTimes.length === 1, `${mode}: sun state persisted`);
}

async function main() {
    const st = await (await fetch(`${BASE}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`)).json();
    const mode = st.entitlements;
    console.log("== mode", mode);
    ok(["free", "owned", "dev"].includes(mode), "status.entitlements " + JSON.stringify(st));

    const a = await mkUser("a"), b = await mkUser("b");
    console.log("== fresh account");
    await commonFresh(a, mode);

    console.log("== legacy maxed profile");
    if (await legacyProfile(b)) {
        const r = await b.details();
        if (mode === "dev") ok(r.scriptData.expansions === 131071, "dev: legacy profile still unlocked");
        else ok(r.scriptData.expansions === 0 && r.currency1 === 0 && r.scriptData.currency2 === 0 && r.scriptData.suns.temporary === 0 && !r.scriptData.virtualGoods.ITEM_PET_DRAGON, "legacy maxed profile no longer unlocked " + JSON.stringify({ c: r.currency1, s: r.scriptData.suns }));
    }

    console.log("== claim");
    if (mode !== "owned") {
        ok(errCode(await a.claim({})) === "ENTITLEMENTS_NOT_OWNED_MODE", `${mode}: claim refused`);
        ok((await a.details()).scriptData.expansions === (mode === "dev" ? 131071 : 0), `${mode}: refused claim changes nothing`);
        return;
    }
    const h = createHash("sha256").update("official-user-" + RUN).digest("hex");
    ok(errCode(await a.claim({ officialUserHash: "xyz", expansions: 1 })) === "ENTITLEMENTS_BAD_HASH", "bad hash");
    ok(errCode(await a.claim({ officialUserHash: h, expansions: -1 })) === "ENTITLEMENTS_BAD_EXPANSIONS", "negative expansions");
    ok(errCode(await a.claim({ officialUserHash: h, expansions: 1.5 })) === "ENTITLEMENTS_BAD_EXPANSIONS", "fractional expansions");
    ok(errCode(await a.claim({ officialUserHash: h, items: "ITEM_PET_DRAGON" })) === "ENTITLEMENTS_BAD_ITEMS", "items not a list");
    ok(errCode(await a.claim({ officialUserHash: h, capturedAt: "" })) === "ENTITLEMENTS_BAD_CAPTURED_AT", "capturedAt missing");
    ok((await a.details()).scriptData.expansions === 0, "invalid claims change nothing");

    const r = await a.claim({ officialUserHash: h, expansions: 1 + 2 + (1 << 20) + 0x100000000, items: ["COLLECTION_VIKING", "BUNDLE_FANTASY_BOARD", "ITEM_PET_DRAGON", "CatanCitiesAndKnights", "BOGUS_ITEM", 42, "ITEM_PET_DRAGON"] });
    ok(!r.error && r.scriptData.expansions === 3 && r.scriptData.items === 3 && r.scriptData.rejected === 1, "claim accepted, mask + catalog filtered " + JSON.stringify(r.scriptData || r.error));
    const d = (await a.details()).scriptData, vg = d.virtualGoods;
    ok(d.expansions === 3 && vg.CatanBaseGame && vg.CatanSeafarer && !vg.CatanCitiesAndKnights, "expansions mirrored (bitmask only)");
    ok(vg.ITEM_PET_DRAGON && vg.COLLECTION_VIKING && vg.ITEM_MALE_VIKING_CLOTH1 && vg.BOARD_TILE_FANTASY && !vg.ITEM_PET_SHEEP && !vg.BOARD_PIECE_VIKING, "items: owned + collection/bundle contents only");
    ok(d.currency1 === 0 && d.currency2 === 0, "wallet not mirrored");
    ok((await b.rpc("ACCOUNT_GET_DETAILS_BY_ID", { PLAYER_ID: a.id })).scriptData.expansions === 3, "others see the mirrored expansions (lobby checks)");
    const shop = (await a.rpc("SHOP_PRODUCTS_FOR_CATEGORIES", { CATEGORIES: ["Expansion", "Bundle"] })).scriptData;
    ok(byId(shop.Expansion, "CatanBaseGame").AlreadyBought === true && byId(shop.Expansion, "CatanCitiesAndKnights").AlreadyBought === false && byId(shop.Bundle, "BUNDLE_FANTASY_BOARD").AlreadyBought === true, "shop AlreadyBought mirrors claim");
    const eq = (await a.rpc("ITEM_EQUIP_ITEM", { ITEM_ID: "ITEM_PET_DRAGON", CATEGORY: "Species", COLOR_ID: "", TIMESTAMP: 2 })).scriptData;
    ok(eq.equipmentItems.Species && eq.equipmentItems.Species.itemId === "ITEM_PET_DRAGON", "owned item can be equipped");

    console.log("== binding");
    ok(errCode(await b.claim({ officialUserHash: h, expansions: 4095 })) === "ENTITLEMENTS_ALREADY_CLAIMED", "same official account, other custom account -> refused");
    ok((await b.details()).scriptData.expansions === 0, "refused claim grants nothing");
    const again = await a.claim({ officialUserHash: h, expansions: 1, items: [] });
    ok(!again.error && (await a.details()).scriptData.expansions === 1, "re-claim by the owner updates (purchases can only be mirrored, a later snapshot replaces the old)");
    await a.rpc("ACCOUNT_DELETE_REQUEST");
    ok(!(await b.claim({ officialUserHash: h, expansions: 1 })).error, "after account deletion the official account can be claimed again");
}

try { await main(); } catch (e) { failures++; console.error("FAIL: exception", e); }
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
