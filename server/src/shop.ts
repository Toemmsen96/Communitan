// SHOP_*: nothing is purchasable (no gold purchases, no real money); AlreadyBought mirrors the player's entitlements
// (entitlements.ts). Contract: economy-ranking.md sec 4. Catalog ids come from the PROD capture (server/data/shop.json, ids only, tools/gen-items.py); names: entLabel.

function shopData(c: GsContext): any {
    return dataLoad(c.ctx, c.nk, "shop.json");
}

const SHOP_HANDLERS: GsHandlerTable = {
    SHOP_GET_CATEGORIES: (c) => ({ categories: shopData(c).categories }),
    SHOP_PRODUCTS_FOR_CATEGORIES: (c) => {
        const out: any = {};
        const prods = shopData(c).products;
        const ent = entFor(c, c.userId);
        for (const cat of c.req.CATEGORIES || []) out[cat] = (prods[cat] || []).map((p: any) => entFlagProduct(p, ent.goods, ent.mode === "dev"));
        return out;
    },
    // Coins = Steam real-money products: none outside dev (payment stays uninitialised, no Steam prices shown).
    SHOP_GET_EXTERNAL_PRODUCTS: (c) => ({ products: entMode(c.ctx) === "dev" ? shopData(c).external.map((p: any) => entFlagProduct(p, {}, true)) : [] }),
    SHOP_GET_DISCOUNT_OR_NEW_OFFERS: () => ({ result: { new: {}, discount: {} } }),
    SHOP_FIND_CATEGORY_WITH_SET_COLLECTION: () => ({ category: "", products: [] }),
    PAYMENT_GET_STEAM_PRODUCT_PRICE: (c) => ({ result: entMode(c.ctx) === "dev" ? shopData(c).prices : [] }),
    // Never grants anything. dev keeps the old "already owned" echo for expansions.
    SHOP_BUY_OFFER: (c) => {
        const id = String(c.req.OFFERCODE || "");
        const prod = entMode(c.ctx) === "dev" ? (shopData(c).products.Expansion || []).filter((p: any) => p.ID === id)[0] : null;
        if (!prod) gsFail({ errorCode: 48, customErrorMessage: ENT_NOT_AVAILABLE });
        return { products: [{ product: entFlagProduct(prod, {}, true) }] };
    },
};
