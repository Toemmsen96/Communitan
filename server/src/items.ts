// ITEM_* : catalog (server/data/items.json, tools/gen-items.py) + equipment persistence. Contract: economy-ranking.md sec 6.

interface ItemIndex { ids: string[]; byId: { [id: string]: any } }
let ITEMS_INDEX: ItemIndex | null = null;

function itemsIndex(c: GsContext): ItemIndex {
    if (ITEMS_INDEX) return ITEMS_INDEX;
    const cat = dataLoad(c.ctx, c.nk, "items.json");
    const idx: ItemIndex = { ids: [], byId: {} };
    for (const k of ["Item", "BoardPieces", "BoardTable", "BoardTile"]) {
        for (const it of cat[k] || []) { idx.ids.push(it.ID); idx.byId[it.ID] = it; }
    }
    ITEMS_INDEX = idx;
    return idx;
}

// CATEGORY arrives as enum name, or possibly as the enum's number.
function itemsCategoryName(v: any): string {
    return typeof v === "number" ? (ACC_CATEGORIES[v] || "") : String(v || "");
}

function itemsApply(c: GsContext, p: Profile, e: any, owned: { [id: string]: number }) {
    const cat = itemsCategoryName(e.CATEGORY);
    const ts = Number(e.TIMESTAMP) || 0;
    if (ts > p.avatar.lastAvatarChangeTime) p.avatar.lastAvatarChangeTime = ts;
    const eq = p.avatar.equipmentItems;
    if (e.UNEQUIP) {
        if (eq[cat] && eq[cat].itemId === e.ITEM_ID) delete eq[cat];
        return;
    }
    const it = itemsIndex(c).byId[e.ITEM_ID];
    if (!it) { c.logger.warn("ITEM_EQUIP unknown item %s", e.ITEM_ID); return; }
    if (!owned[it.ID]) { c.logger.warn("ITEM_EQUIP not owned: %s by %s", it.ID, c.userId); return; }
    const prev = eq[cat] && eq[cat].itemId === it.ID ? eq[cat].colorId : "";
    eq[cat] = { itemId: it.ID, url3d: it.itemDef.url3d, colorId: e.COLOR_ID || prev || it.itemDef.defaultColor || "" };
}

function itemsEquip(c: GsContext): any {
    const p = profileGet(c);
    const r = c.req;
    if (r.SEX) p.avatar.sex = r.SEX;
    if (r.EYE_COLOR_ID) p.avatar.eyecolor = r.EYE_COLOR_ID;
    if (r.SKIN_COLOR_ID) p.avatar.skincolor = r.SKIN_COLOR_ID;
    const owned = entFor(c, c.userId).goods;
    if (r.ITEMS) for (const e of r.ITEMS) itemsApply(c, p, e, owned);
    else if (r.ITEM_ID) itemsApply(c, p, { ITEM_ID: r.ITEM_ID, CATEGORY: r.CATEGORY, COLOR_ID: r.COLOR_ID, TIMESTAMP: r.TIMESTAMP, UNEQUIP: c.id === "ITEM_UNEQUIP_ITEM" }, owned);
    const ts = Number(r.TIMESTAMP) || 0;
    if (ts > p.avatar.lastAvatarChangeTime) p.avatar.lastAvatarChangeTime = ts;
    profileSave(c, p);
    // client feeds this into PlayerDetails.Create + UpdateWithPlayerDetails -> must be the full own profile, not just the avatar block
    return profileFlat(c, c.userId, p, true);
}

const ITEMS_HANDLERS: GsHandlerTable = {
    ITEM_GET_PRODUCT_ITEMS: (c) => {
        const all = dataLoad(c.ctx, c.nk, "items.json");
        const want: string[] = c.req.CATEGORIES || Object.keys(all);
        const ent = entFor(c, c.userId);
        const out: any = {};
        // per-player flags like PROD (AlreadyBought = owned); nothing is purchasable. Ownership itself = virtualGoods.
        for (const k of want) if (all[k]) out[k] = all[k].map((it: any) => entFlagProduct(it, ent.goods, ent.mode === "dev"));
        return out;
    },
    ITEM_EQUIP_ITEM: itemsEquip,
    ITEM_UNEQUIP_ITEM: itemsEquip,
};
