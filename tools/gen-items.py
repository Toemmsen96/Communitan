#!/usr/bin/env python3
"""Catalog -> server/data/{items,shop,prod}.json with ids + technical fields only (never USM's texts).
items.json = ITEM_GET_PRODUCT_ITEMS scriptData (ids, categories, colors, asset paths, level rewards: equipDef.isLocked + itemDef.lvlRequirement).
shop.json  = categories + SHOP_PRODUCTS_FOR_CATEGORIES + SHOP_GET_EXTERNAL_PRODUCTS (ids, bundle contents, sortId, assetbundlePath).
prod.json  = EXPANSION_COMMERCIAL_GET_HINTS keys with this project's own hint text.
Dropped: names, descriptions, ConditionText, lockedReason, prices, Steam prices, per-player flags. The server fills
names from the ids and its own texts at runtime (entitlements.ts entFlagProduct); the client shows those strings as sent.
Source: a PROD capture (default docs/protocol/captures/private/prod-startup.jsonl, kept locally only). Without one the
committed files are re-stripped in place and their asset paths checked against the game's AssetBundles (colors, level
rewards and bundle contents are not in the game files, so a full rebuild needs a capture).
usage: tools/gen-items.py [capture.jsonl] [--game <CatanUniverse_Data>]"""
import glob, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "server", "data")
args = sys.argv[1:]
GAME = os.path.expanduser("~/.local/share/Steam/steamapps/common/Catan Universe/CatanUniverse_Data")
if "--game" in args:
    i = args.index("--game"); GAME = args[i + 1]; del args[i:i + 2]
CAP = args[0] if args else os.path.join(ROOT, "docs/protocol/captures/private/prod-startup.jsonl")

DROP = {"Name", "Description", "ConditionText", "displayName", "description", "lockedReason", "Price", "AlreadyBought", "IsPurchasable"}
HINT = ("Good game! Nothing is sold on this community server: expansions come from the official game. "
        "On servers in \"own purchases\" mode, the expansions you bought there are unlocked here too.")
EXPANSIONS = ["CatanBaseGame", "CatanCitiesAndKnights", "CatanExplorers", "CatanRiseOfTheInkas", "CatanSeafarer", "RivalsAgeOfDarkness",
              "RivalsAgeOfDarkness_EOB", "RivalsAgeOfEnlightenment", "RivalsAgeOfEnlightenment_EOE", "RivalsBaseGame"]


def strip(v):
    if isinstance(v, dict): return {k: strip(x) for k, x in v.items() if k not in DROP}
    if isinstance(v, list): return [strip(x) for x in v]
    return v


def load(name):
    with open(os.path.join(OUT, name)) as f: return json.load(f)


if os.path.exists(CAP):
    rec = {}
    for l in open(CAP):
        r = json.loads(l)
        if r["dir"] == "recv": rec[r["id"]] = r["data"].get("scriptData", {})
    items = rec["ITEM_GET_PRODUCT_ITEMS"]
    shop = {"categories": rec["SHOP_GET_CATEGORIES"]["categories"], "products": rec["SHOP_PRODUCTS_FOR_CATEGORIES"],
            "external": rec["SHOP_GET_EXTERNAL_PRODUCTS"].get("products", [])}
    hints = sorted(rec["EXPANSION_COMMERCIAL_GET_HINTS"]["ExpansionHints"])
    print("source:", CAP)
else:
    items, shop, hints = load("items.json"), load("shop.json"), EXPANSIONS
    print("no capture (%s): re-stripping the committed catalogs" % CAP)
shop["prices"] = []  # Steam prices are per account/currency; real-money products are never offered
items, shop = strip(items), strip(shop)
prod = {"ExpansionHints": {k: {"entries": [HINT]} for k in hints}}

# Asset check: every url3d should exist as an asset bundle of the installed game.
bundles = {os.path.relpath(p, d).replace(os.sep, "/") for d in glob.glob(os.path.join(GAME, "StreamingAssets", "AssetBundles", "*", "Windows"))
           for p in glob.glob(os.path.join(d, "**", "*.default"), recursive=True)}
if bundles:
    urls = {it["itemDef"]["url3d"] for k in items for it in items[k] if it.get("itemDef", {}).get("url3d")}
    missing = sorted(u for u in urls if u not in bundles)
    print("asset bundles:", len(bundles), "catalog url3d:", len(urls), "missing:", missing or "none")

for name, d in (("items", items), ("shop", shop), ("prod", prod)):
    with open(os.path.join(OUT, name + ".json"), "w") as f: json.dump(d, f, indent=1, sort_keys=True)
    print(name, {k: (len(v) if hasattr(v, "__len__") else v) for k, v in d.items()})
