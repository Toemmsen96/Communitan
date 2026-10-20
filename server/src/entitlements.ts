// Entitlements: expansions bitmask + owned item ids (virtualGoods), computed at read time from the server mode.
// Contract: docs/protocol/economy-ranking.md sec 2 + 2a. Nothing here is stored in the profile (old maxed profiles don't matter).
//   env CATAN_ENTITLEMENTS = free (default) | owned
//     free : what a fresh official account has (expansions 0, starter virtualGoods from the PROD capture) + level rewards
//     owned: free + the player's own official purchases, mirrored by the mod (COMMUNITAN_ENTITLEMENTS_CLAIM)
//   env CATAN_DEV_UNLOCK_ALL=1: everything unlocked (local testing only; tools/README.md). Overrides CATAN_ENTITLEMENTS.

type EntMode = "free" | "owned" | "dev";

const ENT_VALID_MASK = 0x1FFFF; // known ExpansionsEnum bits (ACC_EXPANSION_NAMES)
const ENT_CLAIM_COLL = "entitlements"; // key "claim", owned by the player, server-only (perm 0/0)
const ENT_BIND_COLL = "ent_bind";      // key = officialUserHash, system user, value {userId}: first claimer wins
const ENT_MAX_ITEMS = 1000;
const ENT_SUN_RELOAD_MS = 24 * 3600 * 1000; // official reload time unknown; one free AI game per sun per day
// Fresh official account (docs/protocol/captures/prod-startup.schema.jsonl, AccountDetailsResponse scriptData.virtualGoods).
const ENT_STARTER = ["BOARD_PIECE_BASE", "BOARD_TABLE_BASE", "BOARD_TILE_BASE", "COLLECTION_BASE1", "COLOR_AMBERYELLOW", "COLOR_ASHGREY", "COLOR_CARBONBLACK",
    "COLOR_EBONY", "COLOR_EMERALDGREEN", "COLOR_HONEY", "COLOR_IVORY", "COLOR_MAHOGANY", "COLOR_PINK", "COLOR_PLAYER_BLUE", "COLOR_PLAYER_BROWN",
    "COLOR_PLAYER_CREMEWHITE", "COLOR_PLAYER_GREEN", "COLOR_PLAYER_ORANGE", "COLOR_PLAYER_PINK", "COLOR_PLAYER_PURPLE", "COLOR_PLAYER_RED", "COLOR_PORCELAIN",
    "COLOR_PURPLE", "COLOR_SAPPHIREBLUE", "COLOR_TERRACOTTA", "COLOR_WALNUTBROWN", "COLOR_WALNUTBROWN_EYE", "COLOR_WHEATBLOND", "ITEM_BAGPACK_QUIVER",
    "ITEM_FEMALE_CLOTH1", "ITEM_FEMALE_HAIR1", "ITEM_FEMALE_HAIR2", "ITEM_FEMALE_HAIR3", "ITEM_FEMALE_HAIR4", "ITEM_FEMALE_HAIR5", "ITEM_FEMALE_HAIR6",
    "ITEM_FEMALE_HAIR7", "ITEM_FEMALE_HAIR8", "ITEM_MALE_BEARD1", "ITEM_MALE_BEARD2", "ITEM_MALE_BEARD3", "ITEM_MALE_BEARD4", "ITEM_MALE_CLOTH1",
    "ITEM_MALE_HAIR1", "ITEM_MALE_HAIR2", "ITEM_MALE_HAIR3", "ITEM_MALE_HAIR4"];
const ENT_NOT_AVAILABLE = "Not available on this server.";
const ENT_OWNED_TEXT = "Owned.";

function entEnv(ctx: nkruntime.Context, key: string): string {
    return String((ctx && ctx.env && ctx.env[key]) || "").trim().toLowerCase();
}

function entMode(ctx: nkruntime.Context): EntMode {
    const dev = entEnv(ctx, "CATAN_DEV_UNLOCK_ALL");
    if (dev === "1" || dev === "true") return "dev";
    return entEnv(ctx, "CATAN_ENTITLEMENTS") === "owned" ? "owned" : "free";
}

// Startup log (main.ts InitModule).
function entLogMode(ctx: nkruntime.Context, logger: nkruntime.Logger) {
    const m = entMode(ctx);
    const raw = entEnv(ctx, "CATAN_ENTITLEMENTS");
    if (raw && raw !== "free" && raw !== "owned") logger.warn("CATAN_ENTITLEMENTS=%s is unknown, using free", raw);
    if (m === "dev") {
        logger.warn("**********************************************************************************");
        logger.warn("CATAN_DEV_UNLOCK_ALL=1: ALL PAID CONTENT IS UNLOCKED FOR EVERY PLAYER.");
        logger.warn("Local testing only. Never use this on a server other people can reach (README.md, operator liability).");
        logger.warn("**********************************************************************************");
    } else {
        logger.info("entitlements: %s", m);
    }
}

// ---- catalog helpers ----
interface EntCatalog {
    known: { [id: string]: boolean };            // every id a claim may contain (items, colors, boards, collections, bundles)
    levelReward: { id: string; level: number }[]; // PROD: equipDef.isLocked + itemDef.lvlRequirement (granted by level)
    bySet: { [setId: string]: string[] };         // collection -> item ids (itemDef.setCollection)
    bundle: { [bundleId: string]: string[] };     // bundle -> contained product ids
}
let ENT_CATALOG: EntCatalog | null = null;

function entCatalog(c: { ctx: nkruntime.Context; nk: nkruntime.Nakama }): EntCatalog {
    if (ENT_CATALOG) return ENT_CATALOG;
    const items = dataLoad(c.ctx, c.nk, "items.json");
    const shop = dataLoad(c.ctx, c.nk, "shop.json");
    const cat: EntCatalog = { known: {}, levelReward: [], bySet: {}, bundle: {} };
    for (const k of ["Item", "Color", "BoardPieces", "BoardTable", "BoardTile"]) {
        for (const it of items[k] || []) {
            cat.known[it.ID] = true;
            const d = it.itemDef || {};
            if (it.equipDef && it.equipDef.isLocked && (d.lvlRequirement | 0) > 0) cat.levelReward.push({ id: it.ID, level: d.lvlRequirement | 0 });
            if (d.setCollection) (cat.bySet[d.setCollection] = cat.bySet[d.setCollection] || []).push(it.ID);
        }
    }
    for (const p of shop.products.AvatarCollection || []) cat.known[p.ID] = true;
    for (const p of shop.products.Bundle || []) {
        cat.known[p.ID] = true;
        cat.bundle[p.ID] = (p.BundleProducts || []).map((b: any) => b.ID);
    }
    cat.known["COLLECTION_BASE1"] = true;
    ENT_CATALOG = cat;
    return cat;
}

function entIsExpansionName(id: string): boolean {
    return ACC_EXPANSION_NAMES.indexOf(id) >= 0;
}

// ---- claim storage ----
interface EntClaim { expansions: number; items: string[]; officialUserHash: string; capturedAt: string; claimedAt: number }

function entClaimGet(nk: nkruntime.Nakama, userId: string): EntClaim | null {
    return storeGet(nk, ENT_CLAIM_COLL, "claim", userId);
}

// ---- computed entitlements ----
interface Ent { mode: EntMode; expansions: number; goods: { [id: string]: number } }

function entFor(c: { ctx: nkruntime.Context; nk: nkruntime.Nakama }, userId: string): Ent {
    const mode = entMode(c.ctx);
    const goods: { [id: string]: number } = {};
    if (mode === "dev") {
        for (const e of ACC_EXPANSION_NAMES) goods[e] = 1;
        for (const id of Object.keys(entCatalog(c).known)) goods[id] = 1;
        return { mode: mode, expansions: ACC_EXPANSIONS_ALL, goods: goods };
    }
    const cat = entCatalog(c);
    for (const id of ENT_STARTER) goods[id] = 1;
    const level = rkLevel(rkStats(c.nk, userId).xp).level;
    for (const r of cat.levelReward) if (level >= r.level) goods[r.id] = 1;
    let expansions = 0;
    if (mode === "owned" && userId) {
        const cl = entClaimGet(c.nk, userId);
        if (cl) {
            expansions = (cl.expansions | 0) & ENT_VALID_MASK;
            const add = (id: string, depth: number) => {
                if (depth > 3 || entIsExpansionName(id)) return; // expansions only via the bitmask
                if (!cat.known[id]) return;
                goods[id] = 1;
                for (const x of cat.bySet[id] || []) goods[x] = 1;
                for (const x of cat.bundle[id] || []) add(x, depth + 1);
            };
            for (const id of cl.items || []) add(id, 0);
        }
    }
    ACC_EXPANSION_NAMES.forEach((name, i) => { if (expansions & (1 << i)) goods[name] = 1; }); // IsPaidUser() looks for these keys
    return { mode: mode, expansions: expansions, goods: goods };
}

function entOwns(c: { ctx: nkruntime.Context; nk: nkruntime.Nakama }, userId: string, id: string): boolean {
    return !!entFor(c, userId).goods[id];
}

// ---- wallet + suns (stored in the profile, defaults = fresh official account) ----
function entDevWallet(): { currency1: number; currency2: number } {
    return { currency1: 99999, currency2: 999 };
}

function entFreeSuns(): { permanent: number; temporary: number; reloadTimes: string[] } {
    return { permanent: 1, temporary: 0, reloadTimes: [] };
}

function entSuns(ctx: nkruntime.Context, p: Profile): { permanent: number; temporary: number; reloadTimes: string[] } {
    if (entMode(ctx) === "dev") return { permanent: 2, temporary: 99, reloadTimes: [] };
    const s = p.suns || entFreeSuns();
    const now = Date.now();
    return { permanent: s.permanent | 0, temporary: s.temporary | 0, reloadTimes: (s.reloadTimes || []).filter((t) => Date.parse(t) > now) };
}

// Profiles from before entitlements (maxed wallet/suns) are reset once to the fresh-account defaults.
function entMigrateProfile(p: Profile): boolean {
    if (p.entV === 1) return false;
    p.currency1 = 0;
    p.currency2 = 0;
    p.suns = entFreeSuns();
    p.entV = 1;
    return true;
}

// ---- shop/catalog texts + flags per player ----
// data/items.json + shop.json carry ids only (tools/gen-items.py drops USM's names/descriptions). The client shows
// Product.Name/Description and itemDef.displayName/description exactly as sent (Product.cs:125, Item.cs:141, no loca keys),
// so names are derived from the id; a host may add its own Name/Description/displayName/description to the data files.
function entLabel(id: string): string {
    const coins = /^cu_coins_v\d+_(\d+)$/.exec(id || "");
    if (coins) return coins[1]; // numeric name -> the shop shows it with the coin icon (ShopProductEntry.cs:102)
    let s = String(id || "").replace(/^(ITEM|COLOR|COLLECTION|BUNDLE)_/, "");
    // BOARD_PIECE_VIKING -> Board Piece Viking, CatanSeafarer -> Catan Seafarer, ITEM_MALE_HAIR3 -> Male Hair 3
    s = s.split("_").filter((w) => w).map((w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w.replace(/([a-z])([A-Z])/g, "$1 $2"))).join(" ");
    return s.replace(/([A-Za-z])(\d+)$/, "$1 $2");
}

const ENT_SHOP_CATEGORIES = ["Coins", "Expansion", "AvatarCollection", "Bundle"]; // products that carry Name/Description

function entFlagProduct(p: any, owned: { [id: string]: number }, dev: boolean): any {
    const q: any = {};
    for (const k in p) q[k] = p[k];
    const d = p.itemDef;
    if (d) {
        q.itemDef = {};
        for (const k in d) q.itemDef[k] = d[k];
        if (!q.itemDef.displayName) q.itemDef.displayName = entLabel(p.ID);
        if (q.itemDef.description === undefined) q.itemDef.description = "";
        const lvl = d.lvlRequirement | 0;
        if (p.equipDef && p.equipDef.isLocked && !p.equipDef.lockedReason && lvl > 0) {
            q.equipDef = {};
            for (const k in p.equipDef) q.equipDef[k] = p.equipDef[k];
            q.equipDef.lockedReason = "Unlocks at level " + lvl + ".";
        }
    }
    if (!d || ENT_SHOP_CATEGORIES.indexOf(p.Category) >= 0) {
        if (!q.Name) q.Name = d ? q.itemDef.displayName : entLabel(p.ID);
        if (q.Description === undefined) q.Description = "";
    }
    if (q.Price === undefined) q.Price = -1; // Product.Price defaults to -2121 when missing
    let have = dev || !!owned[p.ID];
    if (p.BundleProducts) {
        q.BundleProducts = p.BundleProducts.map((b: any) => entFlagProduct(b, owned, dev));
        if (!have && q.BundleProducts.length) have = q.BundleProducts.every((b: any) => b.AlreadyBought);
    }
    q.AlreadyBought = have;
    q.IsPurchasable = false; // no purchases on custom servers (no real money, no gold)
    q.ConditionText = have ? ENT_OWNED_TEXT : ENT_NOT_AVAILABLE;
    return q;
}

// ---- COMMUNITAN_ENTITLEMENTS_CLAIM ----
function entClaim(c: GsContext): any {
    if (entMode(c.ctx) !== "owned") gsFail({ code: "ENTITLEMENTS_NOT_OWNED_MODE" });
    const r = c.req;
    const hash = String(r.officialUserHash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) gsFail({ code: "ENTITLEMENTS_BAD_HASH" });
    const exp = Number(r.expansions);
    if (!isFinite(exp) || exp < 0 || Math.floor(exp) !== exp) gsFail({ code: "ENTITLEMENTS_BAD_EXPANSIONS" });
    if (r.items !== undefined && !Array.isArray(r.items)) gsFail({ code: "ENTITLEMENTS_BAD_ITEMS" });
    const list: any[] = r.items || [];
    if (list.length > ENT_MAX_ITEMS) gsFail({ code: "ENTITLEMENTS_BAD_ITEMS" });
    const at = String(r.capturedAt || "");
    const atMs = Date.parse(at);
    if (!at || isNaN(atMs) || atMs > Date.now() + 86400000) gsFail({ code: "ENTITLEMENTS_BAD_CAPTURED_AT" });

    // Soft anti-sharing: an official account (hash) mirrors to the first account on this server that claims it.
    let bound = storeGet(c.nk, ENT_BIND_COLL, hash, STORE_SYSTEM_USER);
    if (!bound) {
        try {
            c.nk.storageWrite([{ collection: ENT_BIND_COLL, key: hash, userId: STORE_SYSTEM_USER, value: { userId: c.userId, at: Date.now() }, version: "*", permissionRead: 0, permissionWrite: 0 }]);
            bound = { userId: c.userId };
        } catch (e) {
            bound = storeGet(c.nk, ENT_BIND_COLL, hash, STORE_SYSTEM_USER); // lost a race
        }
    }
    if (!bound || bound.userId !== c.userId) gsFail({ code: "ENTITLEMENTS_ALREADY_CLAIMED" });

    const cat = entCatalog(c);
    const seen: { [id: string]: boolean } = {};
    const items: string[] = [];
    let rejected = 0;
    for (const x of list) {
        const id = typeof x === "string" ? x : "";
        if (!id || seen[id]) continue;
        seen[id] = true;
        if (cat.known[id]) items.push(id);
        else if (!entIsExpansionName(id)) rejected++;
    }
    const claim: EntClaim = { expansions: exp & ENT_VALID_MASK, items: items, officialUserHash: hash, capturedAt: new Date(atMs).toISOString(), claimedAt: Date.now() };
    c.nk.storageWrite([{ collection: ENT_CLAIM_COLL, key: "claim", userId: c.userId, value: claim, permissionRead: 0, permissionWrite: 0 }]);
    return { expansions: claim.expansions, items: items.length, rejected: rejected };
}

const ENTITLEMENT_HANDLERS: GsHandlerTable = {
    COMMUNITAN_ENTITLEMENTS_CLAIM: entClaim,
};
