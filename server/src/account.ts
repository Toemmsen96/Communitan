// ACCOUNT_*, AccountDetailsRequest, ChangeUserDetailsRequest, ITEM_EQUIP/UNEQUIP. Contract: docs/protocol/account-social.md sec 1-2, economy-ranking.md sec 2/6.

const ACC_EXPANSIONS_ALL = 131071; // ExpansionsEnum bits 0x1..0x10000
const ACC_EXPANSION_NAMES = ["CatanBaseGame", "CatanSeafarer", "CatanCitiesAndKnights", "RivalsBaseGame", "RivalsAgeOfDarkness", "RivalsAgeOfEnlightenment",
    "CatanArrivalAtCatan", "CatanRiseOfTheInkas", "RivalsAgeOfEnlightenment_EOE", "CatanExplorers", "RivalsAgeOfDarkness_EOB", "CatanBigGame",
    "Christmas2025_Season", "QATest2026Season", "April2026Season", "May2026Season", "June2026Season"];
const ACC_ELO_EXPANSIONS = ACC_EXPANSION_NAMES.slice(0, 12);
const ACC_CATEGORIES = ["Back", "Beard", "Color", "Cloth", "Eye", "Hair", "Skin", "BoardPieces", "BoardTable", "Collection", "BoardTile", "Species"];

interface Profile {
    displayName: string;
    authType: string;
    currency1: number;
    currency2: number;
    level: number;
    xp: number;
    xpToNext: number;
    karma: number;
    suns: { permanent: number; temporary: number; reloadTimes: string[] };
    avatar: { sex: string; skincolor: string; eyecolor: string; lastAvatarChangeTime: number; equipmentItems: { [cat: string]: { itemId: string; url3d: string; colorId: string } } };
    achievements: { [id: string]: { progress: number } };
    tutorialPlayed: { [exp: string]: number[] };
    metaTutorial: { currentStep: string; stepsCompleted: string[] };
    newsSeen: boolean;
    newsSeenAt?: number; // SERVERNEWS lastUpdated (ms) the player marked seen
    promosShown: string[];
    entV?: number; // 1 = wallet/suns use the entitlements defaults (entitlements.ts entMigrateProfile)
}

function accNameKey(nk: nkruntime.Nakama, name: string): string {
    return nk.sha256Hash(name.toLowerCase());
}

// Claims a display name (unique, case-insensitive). False if owned by someone else.
function accClaimName(nk: nkruntime.Nakama, userId: string, name: string): boolean {
    const key = accNameKey(nk, name);
    try {
        storePut(nk, "names", key, STORE_SYSTEM_USER, { userId: userId, name: name }, "*");
        return true;
    } catch (e) {
        const cur = storeGet(nk, "names", key, STORE_SYSTEM_USER);
        return !!cur && cur.userId === userId;
    }
}

function accReleaseName(nk: nkruntime.Nakama, userId: string, name: string) {
    if (!name) return;
    const key = accNameKey(nk, name);
    const cur = storeGet(nk, "names", key, STORE_SYSTEM_USER);
    if (cur && cur.userId === userId) nk.storageDelete([{ collection: "names", key: key, userId: STORE_SYSTEM_USER }]);
}

function accDefaultProfile(c: GsContext): Profile {
    const acc = c.nk.accountGetId(c.userId);
    const cred = !!acc.email;
    const name = cred ? acc.user.username : "";
    if (name) accClaimName(c.nk, c.userId, name);
    return {
        displayName: name, authType: cred ? "Credentials" : "Device", currency1: 0, currency2: 0,
        level: 25, xp: 0, xpToNext: 0, karma: 3.0, suns: entFreeSuns(), entV: 1,
        avatar: {
            sex: "Female", skincolor: "COLOR_IVORY", eyecolor: "COLOR_WALNUTBROWN_EYE", lastAvatarChangeTime: 0,
            equipmentItems: {
                Hair: { itemId: "ITEM_FEMALE_HAIR1", colorId: "COLOR_CARBONBLACK", url3d: "female/hair/female_hair_01.default" },
                Cloth: { itemId: "ITEM_FEMALE_CLOTH1", colorId: "COLOR_SAPPHIREBLUE_CLOTH", url3d: "female/cloth/female_cloth_01.default" },
                BoardPieces: { itemId: "BOARD_PIECE_BASE", colorId: "COLOR_PLAYER_RED", url3d: "board/pieces/board_piece_base.default" },
                BoardTable: { itemId: "BOARD_TABLE_BASE", colorId: "COLOR_PLAYER_RED", url3d: "board/table/board_table_base.default" },
                BoardTile: { itemId: "BOARD_TILE_BASE", colorId: "COLOR_PLAYER_RED", url3d: "board/tile/board_tile_base.default" },
            },
        },
        achievements: {}, tutorialPlayed: {}, metaTutorial: { currentStep: "", stepsCompleted: [] }, newsSeen: false, promosShown: [],
    };
}

function profileGet(c: GsContext): Profile {
    const p: Profile = storeGetOrInit(c.nk, "profile", "main", c.userId, () => accDefaultProfile(c));
    if (entMigrateProfile(p)) profileSave(c, p);
    return p;
}

// Wallet shown to the client: stored (earned) amounts; dev unlock shows the old maxed values.
function accWallet(c: GsContext, p: Profile): { currency1: number; currency2: number } {
    return entMode(c.ctx) === "dev" ? entDevWallet() : { currency1: p.currency1 | 0, currency2: p.currency2 | 0 };
}

function profileSave(c: GsContext, p: Profile) {
    storePut(c.nk, "profile", "main", c.userId, p);
}

function accAvatarBlock(p: Profile): any {
    // client uses FileTime (~1.3e17 > 2^53): JSON doubles may round below the client's value, and the client ignores older avatar data -> round up
    const t = p.avatar.lastAvatarChangeTime;
    return { lastAvatarChangeTime: t > 9007199254740992 ? t + 64 : t, sex: p.avatar.sex, skincolor: p.avatar.skincolor, eyecolor: p.avatar.eyecolor, equipmentItems: p.avatar.equipmentItems };
}

// Flat PlayerDetails object (sec 1.1 scriptData / 1.2). `own` adds wallet + virtualGoods. Entitlements are derived (entitlements.ts).
function profileFlat(c: GsContext, userId: string, p: Profile, own: boolean): any {
    const st = rkStats(c.nk, userId); // ELO/XP: single source = mp_stats (ranking.ts)
    const ent = entFor(c, userId);
    const lv = rkLevel(st.xp);
    const elo: any = {};
    for (const e of ACC_ELO_EXPANSIONS) elo[e] = (st.elo && st.elo[e]) || 1000.0;
    const d: any = {
        userId: userId, displayName: p.displayName, authenticationType: p.authType, guildName: socGuildName(c.nk, userId), level: lv.level,
        xpForThisLevel: lv.xp, xpFromThisLevelToNext: lv.next, xpBoost: 1.0, karma: p.karma, elo: elo,
        expansions: ent.expansions, expansionsViaPromoFlag: 0, achievementsProgress: p.achievements, achievements: [], eloPlacement: st.eloPlacement || {},
        online: true, ingame: false, playercolor: 1, // PROD sends these for the own profile (playercolor = PlayerColorIdx, default 1)
    };
    const a = accAvatarBlock(p);
    for (const k in a) d[k] = a[k];
    if (own) {
        const w = accWallet(c, p);
        d.currency1 = w.currency1;
        d.currency2 = w.currency2;
        d.suns = entSuns(c.ctx, p);
        d.scrollsEnabled = ent.mode === "dev"; // tickets could unlock expansions (TICKET_UNLOCK_EXPANSION): dev only
        d.needsEmailVerification = accVerifyNeeded(c);
        d.lastSeenTOS = TERMS_DATE;
        d.lastSeenAGB = TERMS_DATE;
        d.aiPlayerVersion = 1; // StreamingAssets/aiPlayerVersion1.txt exists -> client uses its local AI files
        d.almanacVersion = contentAlmanacVersion(c); // 0 without data/almanac.json: client keeps its own
        d.virtualGoodsVersions = 1;
        d.canCreateTournament = true;
        d.canCreateFreeTournament = false;
        d.canCreateTournament_beta = false;
        const asp = socAspirantGuildId(c.nk, userId);
        if (asp) d.aspirantForGuildId = asp;
        d.virtualGoods = ent.goods;
    }
    return d;
}

// Account deletion: module data first (guild, lobbies, leaderboard records, names, owned storage), then the Nakama account
// (which drops friend edges, devices, custom/email links). Running game sessions are left to the ping timeout.
function accDeleteUserData(c: GsContext) {
    const uid = c.userId;
    socGuildRemoveUser(c);
    mpLobbyLeaveAll(c);
    for (const r of c.nk.sqlQuery("SELECT leaderboard_id FROM leaderboard_record WHERE owner_id = $1", [uid])) {
        try { c.nk.leaderboardRecordDelete(r.leaderboard_id, uid); } catch (e) { c.nk.tournamentRecordDelete(r.leaderboard_id, uid); }
    }
    // system-owned docs pointing at the user: display name claims, official-account binding (entitlements.ts)
    const names = c.nk.sqlQuery("SELECT collection, key FROM storage WHERE collection IN ('names', 'ent_bind') AND user_id = $1 AND value->>'userId' = $2", [STORE_SYSTEM_USER, uid]);
    const own = c.nk.sqlQuery("SELECT collection, key FROM storage WHERE user_id = $1", [uid]);
    const dels: nkruntime.StorageDeleteRequest[] = names.map((r) => ({ collection: r.collection, key: r.key, userId: STORE_SYSTEM_USER }));
    for (const r of own) dels.push({ collection: r.collection, key: r.key, userId: uid });
    if (dels.length) c.nk.storageDelete(dels);
}

// Email verification without mail (docs/protocol/account-social.md ACCOUNT_EMAIL_VERIFY). env CATAN_EMAIL_VERIFICATION=ingame|off (default ingame).
// Marker = storage email_verify/pending owned by the user, server-only (perm 0/0, invisible to client storage APIs), value {code}.
// Absent = verified, so accounts from before this feature and device accounts never need it. Deleted with the account's owned storage.
const ACC_VERIFY_COLL = "email_verify";
const ACC_VERIFY_KEY = "pending";

function accVerifyOff(ctx: nkruntime.Context): boolean {
    return String((ctx.env && ctx.env["CATAN_EMAIL_VERIFICATION"]) || "ingame").trim().toLowerCase() === "off";
}

function accVerifyNewCode(nk: nkruntime.Nakama): string {
    const n = parseInt(nk.uuidv4().replace(/-/g, "").substring(0, 12), 16) % 100000; // uuidv4 = crypto random
    return ("00000" + n).slice(-5); // 5 digits: client RegisterStep2ScreenRework.CODE_LENGTH, Activate only enabled at length 5
}

function accVerifyWrite(nk: nkruntime.Nakama, userId: string, code: string) {
    nk.storageWrite([{ collection: ACC_VERIFY_COLL, key: ACC_VERIFY_KEY, userId: userId, value: { code: code }, permissionRead: 0, permissionWrite: 0 }]);
}

// Called after a new email account was created (registration).
function accVerifyStart(ctx: nkruntime.Context, nk: nkruntime.Nakama, userId: string) {
    if (!accVerifyOff(ctx)) accVerifyWrite(nk, userId, accVerifyNewCode(nk));
}

// Pending marker (code created on first need), or null when the caller needs no verification.
function accVerifyPending(c: GsContext): { code: string } | null {
    if (accVerifyOff(c.ctx)) return null;
    const v = storeGet(c.nk, ACC_VERIFY_COLL, ACC_VERIFY_KEY, c.userId);
    if (!v) return null;
    if (!v.code) { v.code = accVerifyNewCode(c.nk); accVerifyWrite(c.nk, c.userId, v.code); }
    return v;
}

function accVerifyNeeded(c: GsContext): boolean {
    return !accVerifyOff(c.ctx) && !!storeGet(c.nk, ACC_VERIFY_COLL, ACC_VERIFY_KEY, c.userId);
}

// Caller-only: a given email must be the caller's own (else 8 AccountDoesntExist). Device accounts have no email -> any given email mismatches.
function accVerifyCheckEmail(c: GsContext) {
    const email = String(c.req.email || "").trim().toLowerCase();
    if (!email) return;
    const own = String(c.nk.accountGetId(c.userId).email || "").toLowerCase();
    if (email !== own) gsFail({ errorCode: 8 });
}

const ACCOUNT_HANDLERS: GsHandlerTable = {
    ACCOUNT_LOGIN: (c) => {
        const p = profileGet(c);
        const t = c.req.AUTHENTICATION_TYPE;
        if (t && t !== p.authType) { p.authType = t; profileSave(c, p); }
        // PROD answers with the own PlayerDetails (no almanac/tournament/version extras)
        const d = profileFlat(c, c.userId, p, true);
        for (const k of ["almanacVersion", "virtualGoodsVersions", "canCreateTournament", "canCreateFreeTournament", "canCreateTournament_beta", "scrollsEnabled", "needsEmailVerification", "lastSeenTOS", "lastSeenAGB", "aiPlayerVersion", "achievementsProgress", "xpBoost", "aspirantForGuildId"]) delete d[k];
        return d;
    },

    AccountDetailsRequest: (c) => {
        const p = profileGet(c);
        const sd = profileFlat(c, c.userId, p, true);
        return gsRaw({ userId: c.userId, displayName: p.displayName, currency1: sd.currency1, currency2: sd.currency2, currency3: 0, currency4: 0, currency5: 0, currency6: 0,
            achievements: [], virtualGoods: sd.virtualGoods, scriptData: sd });
    },

    ChangeUserDetailsRequest: (c) => {
        const name = String(c.req.displayName || "").trim();
        if (!name) return {};
        const p = profileGet(c);
        if (name === p.displayName) return {};
        if (!accClaimName(c.nk, c.userId, name)) gsFail({ displayName: "already set" });
        accReleaseName(c.nk, c.userId, p.displayName);
        p.displayName = name;
        profileSave(c, p);
        try { c.nk.accountUpdateId(c.userId, null, name); } catch (e) { c.logger.warn("accountUpdateId: %s", String(e)); }
        return {};
    },

    ACCOUNT_GET_DETAILS_BY_ID: (c) => {
        const id = String(c.req.PLAYER_ID || "");
        if (!id) gsFail({ errorCode: 38 });
        const p = storeGet(c.nk, "profile", "main", id);
        if (!p) {
            if (id === c.userId) return profileFlat(c, id, profileGet(c), true);
            // Accounts that never stored a profile still get defaults; only unknown ids are 38. The game sends this as a
            // durable request and retries errors forever (seen: ~3 req/s per id in leaderboards/lobbies).
            let exists = false;
            try { exists = !!c.nk.accountGetId(id); } catch (e) { exists = false; }
            if (!exists) gsFail({ errorCode: 38 });
            return profileFlat(c, id, accDefaultProfile({ nk: c.nk, userId: id } as GsContext), false);
        }
        return profileFlat(c, id, p, id === c.userId);
    },

    // Free AI game of a not-owned expansion (UiRework/ScenarioCardManager.cs SunClicked): temporary first, else a permanent
    // sun goes into reload for ENT_SUN_RELOAD_MS. Durable request: a resend after a lost response may use a second sun.
    ACCOUNT_USE_SUN: (c) => {
        const p = profileGet(c);
        const s = entSuns(c.ctx, p);
        if (entMode(c.ctx) === "dev") return { suns: s };
        if (s.temporary > 0) s.temporary--;
        else if (s.permanent - s.reloadTimes.length > 0) s.reloadTimes.push(new Date(Date.now() + ENT_SUN_RELOAD_MS).toISOString());
        else gsFail({ errorCode: 48, customErrorMessage: "No sun available right now." });
        p.suns = s;
        profileSave(c, p);
        return { suns: s };
    },
    // No mail: the activation code is returned to the (authenticated) caller and shown in-game by the mod.
    ACCOUNT_RESEND_ACTIVATION_CODE: (c) => {
        accVerifyCheckEmail(c);
        const p = accVerifyPending(c);
        return p ? { code: p.code, delivery: "ingame" } : { delivery: "auto" };
    },
    ACCOUNT_EMAIL_VERIFY: (c) => {
        accVerifyCheckEmail(c);
        const p = accVerifyPending(c);
        if (!p) {
            if (accVerifyOff(c.ctx)) c.nk.storageDelete([{ collection: ACC_VERIFY_COLL, key: ACC_VERIFY_KEY, userId: c.userId }]);
            return {};
        }
        const code = String(c.req.code || "").trim();
        if (!code) gsFail({ errorCode: 106 });
        if (code !== p.code) gsFail({ errorCode: 105 });
        c.nk.storageDelete([{ collection: ACC_VERIFY_COLL, key: ACC_VERIFY_KEY, userId: c.userId }]);
        return {};
    },
    ACCOUNT_DELETE_REQUEST: (c) => {
        try {
            accDeleteUserData(c);
            c.nk.accountDeleteId(c.userId, false);
        } catch (e) {
            if (e instanceof GsError) throw e;
            c.logger.error("ACCOUNT_DELETE_REQUEST %s: %s", c.userId, String(e));
            gsFail("ACCOUNT_DELETE_FAILED");
        }
        return {}; // returned after deletion: the RPC response still reaches the client, which then logs out
    },
    // No mail: never hand out reset codes in-game (anyone knowing an email could take the account over).
    // Password reset = operator sets a new password in the Nakama console (docs/HOSTING.md).
    ACCOUNT_CHANGE_PASSWORD_REQUEST: () => ({}),
    ACCOUNT_CHANGE_PASSWORD: () => gsFail({ errorCode: 17 }),
};
