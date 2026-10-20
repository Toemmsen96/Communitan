// Static/semi-static content + menu-startup stubs: TERMS, ALMANAC, SERVERNEWS, PROMOTION, tutorials, AI players, seasons, tournaments, achievements.
// Contract: account-social.md sec 2, economy-ranking.md sec 8-13.

const TERMS_DATE = 1735689600000; // 2025-01-01 (lastSeenTOS/AGB, ms)
const TERMS_DATE_ISO = new Date(TERMS_DATE).toISOString(); // PROD sends tosDate/agbDate as ISO string
const DISCLAIMER = "Unofficial fan project, not affiliated with or endorsed by United Soft Media (USM), CATAN GmbH or the original game. Personal project, provided as is without warranty.";
const SECURITY_NOTE = "This server is community hosted: its operator can see your email, password, device id, IP address, chats and game data. Never use your official Catan Universe password or any password you use elsewhere here.";
const PROGRESS_NOTE = "Progress, items, ratings, leaderboards, friends and guilds on this server are separate from the official servers and from other community servers and do not carry over in either direction.";
function contentNews(c: GsContext): { title: string; content: string; linkURL: string; at: number } {
    const n = dataLoad(c.ctx, c.nk, "news.json");
    const m = entMode(c.ctx);
    const ent = m === "owned" ? "Paid content: the expansions and items you bought on the official servers are unlocked here (mirrored by the mod after you log in there once). Nothing is sold on this server."
        : m === "free" ? "Paid content: this server gives you what a free official account has. Nothing is sold on this server." : "";
    const text = (n.content ? n.content + "\n\n" : "") + SECURITY_NOTE + "\n\n" + PROGRESS_NOTE + (ent ? "\n\n" + ent : "") + "\n\n" + DISCLAIMER;
    return { title: n.title || "Community server", content: text, linkURL: n.linkURL || "", at: Date.parse(n.lastUpdated) || 0 };
}

// Client parses "ddd MMM dd yyyy HH:mm:ss 'GMT+0000 (UTC)'" (Common.Net/ServerNewsResponse.cs).
function contentGmtString(ms: number): string {
    const d = new Date(ms);
    const p2 = (x: number) => (x < 10 ? "0" : "") + x;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return days[d.getUTCDay()] + " " + months[d.getUTCMonth()] + " " + p2(d.getUTCDate()) + " " + d.getUTCFullYear() + " " +
        p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds()) + " GMT+0000 (UTC)";
}

const TERMS_TEXT = "Catan Universe custom server. " + DISCLAIMER + " " + SECURITY_NOTE + " " + PROGRESS_NOTE + " No data is sold. By playing you agree to be nice.";
const TUTORIAL_EXPANSIONS = ["CatanBaseGame", "CatanCitiesAndKnights", "CatanSeafarer", "RivalsBaseGame", "CatanRiseOfTheInkas"];

// Almanac (account-social.md sec 2): data/almanac.json is NOT shipped (USM text); hosts generate it from their own game
// install with tools/gen-almanac.py (English, StreamingAssets/Almanac). Client (NakamaSender.cs:458-470, AlmanacController.cs):
// it downloads only if almanacVersion > local version or the local almanac's language != the UI language, and it SAVES
// whatever ALMANAC_GET_DATA returns, an error as an empty almanac (that would wipe the saved one, shared with the official
// servers). So: without data (or for another language) report version 0 and answer without an `almanac` list: the client's
// Category.CreateFromJson then fails before saving (exception caught and logged by PlatformBase.Update) and the player keeps
// the almanac they have (bundled English, or one in their language from the official servers).
const CONTENT_NO_ALMANAC = { almanacVersion: 0 };

function contentAlmanac(c: GsContext): any {
    const a = dataLoadOpt(c.ctx, c.nk, "almanac.json");
    if (!a || !a.almanac || !a.almanac.length) return null;
    a.almanac.forEach((cat: any, i: number) => { // PROD category shape: id "categoryNN" + dontShowInClient
        if (!cat.id) cat.id = "category" + (i < 10 ? "0" : "") + i;
        if (cat.dontShowInClient === undefined) cat.dontShowInClient = false;
    });
    return a;
}

function contentAlmanacVersion(c: GsContext): number {
    const a = contentAlmanac(c);
    return a ? Number(a.almanacVersion) || 1 : 0;
}

function contentAlmanacData(c: GsContext): any {
    const a = contentAlmanac(c);
    const want = String(c.req.LANGUAGE || "").toLowerCase();
    if (!a || (want && want !== String(a.language || "en").toLowerCase())) return CONTENT_NO_ALMANAC;
    return { almanacVersion: a.almanacVersion, almanac: a.almanac };
}

// AI players: ids = AIPlayerNames enum, look = StreamingAssets/<Name>.txt (thrift) decoded by hand. difficulty = AIDifficulty (Easy 0, Normal 1, Hard 2).
const CONTENT_AI_FEMALE = ["Lin", "Jean", "Marianne", "Hildegard"];
const CONTENT_AI_NAMES = ["Candamir", "Nassir", "Vincent", "Lin", "Jean", "Marianne", "William", "Hildegard", "Siegfried", "Louis"];

function contentAiPlayers(): any[] {
    const out: any[] = [];
    const variants = [["", 1], ["_easy", 0], ["_hard", 2]];
    for (const v of variants) {
        for (const n of CONTENT_AI_NAMES) {
            const f = CONTENT_AI_FEMALE.indexOf(n) >= 0;
            const s = f ? "female" : "male";
            out.push({
                userId: n + v[0], displayName: n, isAi: true, difficulty: v[1], hidden: false, sex: f ? "Female" : "Male",
                skincolor: "COLOR_IVORY", eyecolor: "COLOR_SAPPHIREBLUE",
                equipmentItems: {
                    Cloth: { itemId: "ITEM_" + s.toUpperCase() + "_CLOTH1", colorId: "COLOR_SAPPHIREBLUE_CLOTH", url3d: s + "/cloth/" + s + "_cloth_01.default" },
                    Hair: { itemId: "ITEM_" + s.toUpperCase() + "_HAIR1", colorId: "COLOR_CARBONBLACK", url3d: s + "/hair/" + s + "_hair_01.default" },
                },
            });
        }
    }
    return out;
}

function contentTutorialCounts(p: Profile, exp: string): number[] {
    return p.tutorialPlayed[exp] || [];
}

const CONTENT_HANDLERS: GsHandlerTable = {
    TERMS_GET_TOS: () => ({ TOS: TERMS_TEXT, tosDate: TERMS_DATE_ISO }),
    TERMS_GET_AGB: () => ({ AGB: TERMS_TEXT, agbDate: TERMS_DATE_ISO }),
    TERMS_ACCEPT_TOS: () => ({}),
    TERMS_ACCEPT_AGB: () => ({}),

    ALMANAC_GET_VERSION: (c) => ({ almanacVersion: contentAlmanacVersion(c) }),
    ALMANAC_GET_DATA: contentAlmanacData,

    // Unseen news pops up on the main menu (GameHub.States/MainState.cs:144); the notes are always appended.
    SERVERNEWS_GET: (c) => {
        const n = contentNews(c);
        return { news: { title: n.title, content: n.content, lang: String(c.req.LANGUAGE || "en"), lastUpdated: contentGmtString(n.at), linkURL: n.linkURL, seenByPlayer: (profileGet(c).newsSeenAt || 0) >= n.at } };
    },
    SERVERNEWS_MARK_SEEN: (c) => { const p = profileGet(c); p.newsSeenAt = contentNews(c).at; profileSave(c, p); return {}; },

    PROMOTION_GET_PLAYERS_PROMOTIONS: () => ({
        activeFeatures: { durationFeatures: { Expansion: [], XPBoost: [] }, features: {} }, activePromotions: [], activePromotionsAll: [], currentTime: new Date().toISOString(),
    }),
    PROMOTION_SEND_CODE: () => ({ promotionResults: "KEY_NOT_EXISTS" }),
    PROMOTION_SHOWN: (c) => { const p = profileGet(c); const id = String(c.req.ID || ""); if (id && p.promosShown.indexOf(id) < 0) { p.promosShown.push(id); profileSave(c, p); } return {}; },

    META_TUTORIAL_GET_PROGRESS: (c) => { const m = profileGet(c).metaTutorial; return { currentStep: m.currentStep, stepsCompleted: m.stepsCompleted }; },
    META_TUTORIAL_STARTED: (c) => {
        const p = profileGet(c);
        const id = String(c.req.TUTORIAL_ID || "");
        if (id) {
            p.metaTutorial.currentStep = id;
            if (p.metaTutorial.stepsCompleted.indexOf(id) < 0) p.metaTutorial.stepsCompleted.push(id);
            profileSave(c, p);
        }
        return {};
    },
    META_TUTORIAL_RESET: (c) => { const p = profileGet(c); p.metaTutorial = { currentStep: "", stepsCompleted: [] }; profileSave(c, p); return { currentStep: "", stepsCompleted: [] }; },

    TUTORIAL_GET_PROGRESS: (c) => {
        const p = profileGet(c);
        const list: any = {};
        for (const e of TUTORIAL_EXPANSIONS) if (p.tutorialPlayed[e]) list[e] = p.tutorialPlayed[e];
        return { tutorialPlayedList: list }; // PROD omits it for a fresh account; client handles both
    },
    TUTORIAL_FINISH_CHAPTER: (c) => {
        const p = profileGet(c);
        const exp = String(c.req.EXPANSION_ID || "");
        const n = Math.max(Number(c.req.CHAPTER_COUNT) || 0, 0);
        const i = Number(c.req.CHAPTER_ID) || 0;
        const a = contentTutorialCounts(p, exp);
        while (a.length < Math.max(n, i + 1)) a.push(0);
        a[i] = 1;
        p.tutorialPlayed[exp] = a;
        profileSave(c, p);
        return { chaptersPlayedCount: a.filter((x) => x === 1).length, xpEarned: 0 };
    },

    GAME_GET_AI_PLAYERDETAILS: () => ({ playerDetails: contentAiPlayers() }),

    BIG_GAME_GET_TURNS: () => ({ serverNowTime: new Date().toISOString(), turns: [] }),

    ACHIEVEMENTS_INCREASE: (c) => {
        const p = profileGet(c);
        const id = String(c.req.ACHIEVEMENT_ID || "");
        if (id) {
            const a = p.achievements[id] || { progress: 0 };
            a.progress++;
            p.achievements[id] = a;
            profileSave(c, p);
        }
        return { achievementsProgress: p.achievements };
    },

    EXPANSION_COMMERCIAL_GET_HINTS: (c) => dataLoad(c.ctx, c.nk, "prod.json"),
    // Tickets never unlock paid expansions here (scrollsEnabled is false outside dev unlock).
    TICKET_UNLOCK_EXPANSION: (c) => (entMode(c.ctx) === "dev" ? {} : gsFail({ errorCode: 48, customErrorMessage: ENT_NOT_AVAILABLE })),

    // friends / blacklist / mail: empty until Phase 7 (correct keys so the client doesn't NRE)

    // misc no-ops
    PUSH_NOTIFICATIONS_GET_OPTIONS: () => ({ news: false, events: false, social: false }),
    PUSH_NOTIFICATIONS_SET_OPTIONS: () => ({}),
    PUSH_NOTIFICATIONS_UNREGISTER: () => ({}),
    PushRegistrationRequest: () => gsRaw({ registrationId: "x" }),
    ERROR_REPORT_EXCEPTION: () => ({}),
    ERROR_AI_CRASH: () => ({}),
    EndSessionRequest: () => ({}),
};
