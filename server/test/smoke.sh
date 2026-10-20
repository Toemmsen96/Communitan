#!/usr/bin/env bash
# Startup-sequence smoke test (docs/protocol/core.md sec 4) for one fresh email user and one fresh device user.
# usage: server/test/smoke.sh   (server must be running on NAKAMA_HOST, default http://127.0.0.1:7350)
exec python3 - "$@" <<'PY'
import base64, json, os, sys, time, urllib.request, urllib.error
HOST = os.environ.get("NAKAMA_HOST", "http://127.0.0.1:7350")
fails = []

def http(path, body=None, token=None, basic=False, method="POST"):
    h = {"Content-Type": "application/json"}
    h["Authorization"] = ("Basic " + base64.b64encode((os.environ.get("NAKAMA_SERVER_KEY", "defaultkey") + ":").encode()).decode()) if basic else ("Bearer " + token)
    req = urllib.request.Request(HOST + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()}

def check(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

class Client:
    def __init__(self, token, label):
        self.token, self.label, self.n = token, label, 0
    def call(self, id_, extra=None):
        self.n += 1
        req = {"@class": "." + id_ if id_.endswith("Request") else ".LogEventRequest", "requestId": "t_%d" % self.n, "communitanCaps": "rng-full-1"}  # mod capability (CATAN_SERVER_RNG=full)
        if not id_.endswith("Request"): req["eventKey"] = id_
        req.update(extra or {})
        r = http("/v2/rpc/" + id_, json.dumps(req), self.token)
        if "payload" not in r:
            check(False, "%s %s: rpc error %s" % (self.label, id_, r)); return {}
        resp = json.loads(r["payload"])
        check(resp.get("@class", "").endswith("Response"), "%s %s: @class %s" % (self.label, id_, resp.get("@class")))
        check(resp.get("requestId") == req["requestId"], "%s %s: requestId echo" % (self.label, id_))
        return resp
    def ok(self, id_, extra=None, keys=(), top=()):
        resp = self.call(id_, extra)
        check("error" not in resp, "%s %s: error %s" % (self.label, id_, resp.get("error")))
        sd = resp.get("scriptData")
        check(isinstance(sd, dict), "%s %s: scriptData missing" % (self.label, id_))
        for k in keys: check(isinstance(sd, dict) and k in sd, "%s %s: scriptData.%s missing" % (self.label, id_, k))
        for k in top: check(k in resp, "%s %s: top-level %s missing" % (self.label, id_, k))
        return resp.get("scriptData") or {}

def ent_mode():  # CATAN_ENTITLEMENTS / CATAN_DEV_UNLOCK_ALL of the server under test (public status)
    try:
        key = os.environ.get("NAKAMA_HTTP_KEY", "catan-public-status")
        return json.load(urllib.request.urlopen(HOST + "/v2/rpc/COMMUNITAN_STATUS?http_key=%s&unwrap" % key)).get("entitlements", "free")
    except Exception:
        return "free"
ENT = ent_mode()
print("entitlements:", ENT)

def startup(c, auth_type, expect_name):
    print("==", c.label)
    items = c.ok("ITEM_GET_PRODUCT_ITEMS", {"CATEGORIES": ["Color", "Item", "BoardTable", "BoardPieces", "BoardTile"]}, ["Color", "Item", "BoardPieces", "BoardTable", "BoardTile"])
    for k in ("Color", "Item", "BoardPieces", "BoardTable"): check(len(items.get(k, [])) > 0, "items %s empty" % k)
    check(all(it["itemDef"]["displayName"] and "description" in it["itemDef"] for k in items for it in items[k]), "item names (id-derived)")
    c.ok("ACCOUNT_LOGIN", {"APP_VERSION": 94, "PLATFORM": "Windows", "LANGUAGE": "English", "AUTHENTICATION_TYPE": auth_type, "VERSION_NAME": "2.7.5"})
    r = c.call("AccountDetailsRequest")
    check("error" not in r, "AccountDetails error")
    for k in ("userId", "displayName", "currency1", "currency2"): check(k in r, "AccountDetails top-level %s" % k)
    check(r.get("displayName") == expect_name, "displayName %r != %r" % (r.get("displayName"), expect_name))
    sd = r.get("scriptData", {})
    for k in ("authenticationType", "lastSeenTOS", "lastSeenAGB", "needsEmailVerification", "scrollsEnabled", "aiPlayerVersion", "almanacVersion", "virtualGoods", "expansions", "level", "suns", "sex", "equipmentItems"):
        check(k in sd, "AccountDetails scriptData.%s" % k)
    check(sd.get("authenticationType") == auth_type, "authenticationType echo")
    check(sd.get("expansions") == (131071 if ENT == "dev" else 0), "expansions (%s)" % ENT)
    check(sd.get("needsEmailVerification") is False, "needsEmailVerification")
    vg = sd.get("virtualGoods", {})
    if ENT == "dev":
        check("CatanSeafarer" in vg and all(i["ID"] in vg for i in items.get("Item", [])), "virtualGoods covers expansions+items")
    else:  # fresh official account: starter items, no expansions, wallet 0
        check("ITEM_MALE_HAIR1" in vg and "COLOR_PLAYER_RED" in vg and "CatanSeafarer" not in vg and "ITEM_PET_DRAGON" not in vg, "virtualGoods = starter set")
        check(r.get("currency1") == 0 and sd.get("currency2") == 0 and sd.get("scrollsEnabled") is False, "wallet 0, scrolls off")
        check(sd.get("suns", {}).get("permanent") == 1, "one permanent sun")
    check(all(e["itemId"] in vg for e in sd.get("equipmentItems", {}).values()), "equipped items owned")
    ids = {i["ID"] for k in ("Item", "BoardPieces", "BoardTable", "BoardTile") for i in items[k]}
    check(all(e["itemId"] in ids for e in sd.get("equipmentItems", {}).values()), "equipped items exist in catalog")
    uid = r["userId"]
    c.ok("TERMS_GET_TOS", {"LANGUAGE": "English"}, ["TOS", "tosDate"])
    c.ok("TERMS_GET_AGB", {"LANGUAGE": "English"}, ["AGB", "agbDate"])
    ai = c.ok("GAME_GET_AI_PLAYERDETAILS", {"INCLUDE_BIG_GAME_PLACEHOLDERS": 1}, ["playerDetails"])
    check(len(ai["playerDetails"]) == 30 and all(p["isAi"] and p["userId"] for p in ai["playerDetails"]), "30 AI players")
    av = c.ok("ALMANAC_GET_VERSION", {}, ["almanacVersion"])["almanacVersion"]
    check(av == sd.get("almanacVersion"), "almanacVersion matches AccountDetails")
    al = c.ok("ALMANAC_GET_DATA", {"LANGUAGE": "en"}, ["almanacVersion"])
    other = c.ok("ALMANAC_GET_DATA", {"LANGUAGE": "de"}, ["almanacVersion"])
    check("almanac" not in other, "almanac: other language gets no list (client keeps its own)")
    if av > 0: check(len(al.get("almanac") or []) > 0 and "entries" in al["almanac"][0], "almanac content (data/almanac.json)")
    else: check(al["almanacVersion"] == 0 and "almanac" not in al, "no data/almanac.json: version 0, no list (client keeps its own)")
    n = c.ok("SERVERNEWS_GET", {"LANGUAGE": "English"}, ["news"])["news"]
    check(n["seenByPlayer"] is False and "do not carry over" in n["content"] and n["lastUpdated"].endswith("GMT+0000 (UTC)"), "news unseen + notes %s" % n["lastUpdated"])
    c.ok("SERVERNEWS_MARK_SEEN"); check(c.ok("SERVERNEWS_GET", {"LANGUAGE": "English"}, ["news"])["news"]["seenByPlayer"] is True, "news seen")
    pr = c.ok("PROMOTION_GET_PLAYERS_PROMOTIONS", {"LANGUAGE": "English"}, ["currentTime", "activePromotions", "activePromotionsAll"])
    c.ok("PROMOTION_SHOWN", {"ID": "x"}); c.ok("PROMOTION_SEND_CODE", {"CODE": "x"}, ["promotionResults"])
    c.ok("META_TUTORIAL_GET_PROGRESS", {}, ["currentStep", "stepsCompleted"])
    c.ok("META_TUTORIAL_STARTED", {"TUTORIAL_ID": "step1"})
    m = c.ok("META_TUTORIAL_GET_PROGRESS", {}, ["currentStep", "stepsCompleted"])
    check(m["currentStep"] == "step1" and m["stepsCompleted"] == ["step1"], "meta tutorial persisted")
    c.ok("TUTORIAL_GET_PROGRESS", {"EXPANSIONS": {"keys": ["CatanBaseGame"]}}, ["tutorialPlayedList"])
    t = c.ok("TUTORIAL_FINISH_CHAPTER", {"CHAPTER_ID": 1, "EXPANSION_ID": "CatanBaseGame", "CHAPTER_COUNT": 3}, ["chaptersPlayedCount", "xpEarned"])
    check(t["chaptersPlayedCount"] == 1, "tutorial chapter count")
    t = c.ok("TUTORIAL_GET_PROGRESS", {}, ["tutorialPlayedList"]); check(t["tutorialPlayedList"].get("CatanBaseGame") == [0, 1, 0], "tutorial persisted")
    sn = c.ok("SEASON_GET_SEASONS_DETAILS", {}, ["seasons"])["seasons"]; check(all(x["state"] == "RUNNING" and x["id"] and x["reward1"] is not None for x in sn), "seasons (data/seasons.json)")
    cfg = c.ok("TOURNAMENT_GET_CONFIG", {}, ["tournamentConfig"]); check(cfg["tournamentConfig"]["isFeatureEnabled"] is False, "tournaments disabled")
    c.ok("TOURNAMENT_GET_MY_LIST", {}, ["tournaments"])
    a = c.ok("ACHIEVEMENTS_INCREASE", {"ACHIEVEMENT_ID": "FirstWin"}, ["achievementsProgress"]); check(a["achievementsProgress"]["FirstWin"]["progress"] == 1, "achievement")
    a = c.ok("ACHIEVEMENTS_INCREASE", {"ACHIEVEMENT_ID": "FirstWin"}, ["achievementsProgress"]); check(a["achievementsProgress"]["FirstWin"]["progress"] == 2, "achievement persisted")
    c.ok("EXPANSION_COMMERCIAL_GET_HINTS", {"LANGUAGE": "English"}, ["ExpansionHints"])
    b = c.ok("GET_BLOCKED_AND_FRIEND_IDS", {}, ["blocked", "friends"]); check(b["blocked"] == [] and b["friends"] == [], "blocked/friends empty")
    c.ok("BLACKLIST_GET_BLOCKED_PLAYERS", {}, ["blockedPlayers"]); c.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 0}, ["messages", "lastIndex"])
    fl = c.call("ListGameFriendsRequest"); check("friends" in fl, "ListGameFriends friends")
    c.call("FRIEND_GET_ONLINE")
    cats = c.ok("SHOP_GET_CATEGORIES", {}, ["categories"])["categories"]; check(len(cats) == 7, "shop categories")
    sp = c.ok("SHOP_PRODUCTS_FOR_CATEGORIES", {"CATEGORIES": cats}, cats); check(all(p["AlreadyBought"] == (ENT == "dev") for p in sp["Expansion"]), "expansions owned iff dev")
    check(not any(p["IsPurchasable"] for k in sp for p in sp[k]), "nothing purchasable")
    check(all(p["Name"] and p["Price"] == -1 for k in sp for p in sp[k]) and all(b.get("Name") or b["itemDef"]["displayName"] for p in sp["Bundle"] for b in p["BundleProducts"]), "product names (id-derived)")
    c.ok("SHOP_GET_EXTERNAL_PRODUCTS", {}, ["products"]); c.ok("SHOP_GET_DISCOUNT_OR_NEW_OFFERS", {}, ["result"])
    c.ok("SHOP_FIND_CATEGORY_WITH_SET_COLLECTION", {"COLLECTION_ID": "x"}, ["category", "products"])
    if ENT == "dev": c.ok("SHOP_BUY_OFFER", {"OFFERCODE": "CatanSeafarer"}, ["products"])
    else: check(c.call("SHOP_BUY_OFFER", {"OFFERCODE": "CatanSeafarer"}).get("error", {}).get("errorCode") == 48, "buy offer refused")
    c.ok("LEADERBOARD_GET_BRACKETS", {}, ["brackets"]); c.ok("LEADERBOARD_GET_BRACKETS_BY_ID", {"PLAYER_ID": uid}, ["brackets"])
    c.call("LeaderboardDataRequest", {"leaderboardShortCode": "PLAYER_ELO_RANKING.EXPANSION.CatanBaseGame"})
    su = c.ok("ACCOUNT_USE_SUN", {}, ["suns"])["suns"]
    if ENT != "dev":
        check(len(su["reloadTimes"]) == 1, "sun used -> reloading")
        check(c.call("ACCOUNT_USE_SUN").get("error") is not None, "no second sun")
    check(c.ok("ACCOUNT_RESEND_ACTIVATION_CODE") == {"delivery": "auto"}, "resend: verified/device -> delivery auto"); c.ok("ACCOUNT_EMAIL_VERIFY", {"code": "1"})
    # equip: single + bulk + unequip, state persists and the response is the full own profile
    ts = int((time.time() + 11644473600) * 1e7)  # FileTime like the client
    e = c.ok("ITEM_EQUIP_ITEM", {"ITEM_ID": "ITEM_FEMALE_HAIR2", "CATEGORY": "Hair", "COLOR_ID": "COLOR_HONEYBLONDE", "TIMESTAMP": ts}, ["equipmentItems", "lastAvatarChangeTime", "virtualGoods", "displayName", "userId", "expansions"])
    check(e["equipmentItems"]["Hair"] == {"itemId": "ITEM_FEMALE_HAIR2", "url3d": "female/hair/female_hair_02.default", "colorId": "COLOR_HONEYBLONDE"}, "equip single")
    e = c.ok("ITEM_EQUIP_ITEM", {"ITEMS": [{"ITEM_ID": "ITEM_MALE_CLOTH2", "CATEGORY": "Cloth", "COLOR_ID": "", "TIMESTAMP": ts + 1, "UNEQUIP": False}, {"ITEM_ID": "ITEM_FEMALE_HAIR2", "CATEGORY": "Hair", "COLOR_ID": "", "TIMESTAMP": ts + 2, "UNEQUIP": True}], "SEX": "Male", "EYE_COLOR_ID": "COLOR_SAPPHIREBLUE", "SKIN_COLOR_ID": "COLOR_SAND", "TIMESTAMP": ts + 3}, ["equipmentItems"])
    check("Hair" not in e["equipmentItems"] and e["equipmentItems"]["Cloth"]["itemId"] == "ITEM_MALE_CLOTH2" and e["sex"] == "Male" and e["eyecolor"] == "COLOR_SAPPHIREBLUE" and e["skincolor"] == "COLOR_SAND", "equip bulk")
    check(ts + 3 <= e["lastAvatarChangeTime"] <= ts + 200, "lastAvatarChangeTime not older than client ts")
    e = c.ok("ITEM_UNEQUIP_ITEM", {"ITEM_ID": "ITEM_MALE_CLOTH2", "CATEGORY": "Cloth", "TIMESTAMP": ts + 4}, ["equipmentItems"]); check("Cloth" not in e["equipmentItems"], "unequip")
    d = c.ok("ACCOUNT_GET_DETAILS_BY_ID", {"PLAYER_ID": uid}, ["displayName", "userId", "equipmentItems"]); check(d["sex"] == "Male", "by-id reflects equipment")
    r = c.call("ACCOUNT_GET_DETAILS_BY_ID", {"PLAYER_ID": "00000000-0000-0000-0000-0000000000ff"}); check(r.get("error", {}).get("errorCode") == 38, "by-id unknown -> 38")
    return uid

stamp = str(int(time.time()))
# --- email user (register: username = display name) ---
name = "Smoke" + stamp[-6:]
s = http("/v2/account/authenticate/email?create=true&username=" + name, {"email": "smoke%s@example.com" % stamp, "password": "password123", "vars": {"authenticationType": "Credentials", "password": "password123", "scriptData": json.dumps({"appVersion": 94})}}, basic=True)
check("token" in s, "email register: %s" % s)
tok = s.get("token", "")
claims = json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "==")) if tok else {}
check("password" not in claims.get("vars", {}), "password stripped from session vars")
relog = http("/v2/account/authenticate/custom?create=false", {"id": __import__("hashlib").sha256(tok.encode()).hexdigest()}, basic=True)
check("token" in relog, "token re-login via custom id: %s" % relog)
c1 = Client(tok, "email")
# --- email verification without mail (docs/protocol/account-social.md ACCOUNT_EMAIL_VERIFY): code returned in-game to the caller only ---
print("== email verification")
email1 = "smoke%s@example.com" % stamp
r = c1.call("AccountDetailsRequest"); vuid = r.get("userId", "")
check(r.get("scriptData", {}).get("needsEmailVerification") is True, "verify: new email account not unverified")
rs = c1.ok("ACCOUNT_RESEND_ACTIVATION_CODE", {"email": email1.upper()}, ["code", "delivery"])
code = rs.get("code", "")
check(rs.get("delivery") == "ingame" and len(code) == 5 and code.isdigit(), "verify: resend %s" % rs)
check(c1.ok("ACCOUNT_RESEND_ACTIVATION_CODE", {"email": email1}).get("code") == code, "verify: code stable across resends")
other = Client(http("/v2/account/authenticate/device?create=true", {"id": "smoke-other-" + stamp}, basic=True).get("token", ""), "other")
for id_, extra in (("ACCOUNT_RESEND_ACTIVATION_CODE", {"email": email1}), ("ACCOUNT_EMAIL_VERIFY", {"email": email1, "code": code})):
    r = other.call(id_, extra); check(r.get("error", {}).get("errorCode") == 8 and code not in json.dumps(r), "verify: %s with foreign email -> %s" % (id_, r))
check(not http("/v2/storage/email_verify?user_id=" + vuid, token=tok, method="GET").get("objects"), "verify: marker listable by client")
check(not http("/v2/storage", {"object_ids": [{"collection": "email_verify", "key": "pending", "user_id": vuid}]}, tok).get("objects"), "verify: marker readable by client")
wrong = "%05d" % ((int(code) + 1) % 100000)
r = c1.call("ACCOUNT_EMAIL_VERIFY", {"code": wrong, "email": email1}); check(r.get("error", {}).get("errorCode") == 105, "verify: wrong code -> %s" % r.get("error"))
r = c1.call("ACCOUNT_EMAIL_VERIFY", {"code": "", "email": email1}); check(r.get("error", {}).get("errorCode") == 106, "verify: empty code -> %s" % r.get("error"))
r = c1.call("ACCOUNT_EMAIL_VERIFY", {"code": code, "email": "x" + email1}); check(r.get("error", {}).get("errorCode") == 8, "verify: wrong email -> %s" % r.get("error"))
check(c1.call("AccountDetailsRequest").get("scriptData", {}).get("needsEmailVerification") is True, "verify: still unverified after failures")
check(c1.ok("ACCOUNT_EMAIL_VERIFY", {"code": code, "email": email1}) == {}, "verify: right code")
check(c1.call("AccountDetailsRequest").get("scriptData", {}).get("needsEmailVerification") is False, "verify: flag not cleared")
check(c1.ok("ACCOUNT_RESEND_ACTIVATION_CODE", {"email": email1}) == {"delivery": "auto"}, "verify: resend after verify")
c1.ok("ACCOUNT_EMAIL_VERIFY", {"code": "00000", "email": email1})
# password reset: no in-game codes, ever (operator resets via console)
check(other.ok("ACCOUNT_CHANGE_PASSWORD_REQUEST", {"EMAIL": email1}) == {}, "pw reset request leaks data")
r = other.call("ACCOUNT_CHANGE_PASSWORD", {"EMAIL": email1, "CODE": code, "PASSWORD": "hijacked123"}); check(r.get("error", {}).get("errorCode") == 17, "pw reset: %s" % r)
check("token" not in http("/v2/account/authenticate/email?create=false", {"email": email1, "password": "hijacked123"}, basic=True), "pw reset took over account")
uid1 = startup(c1, "Credentials", name)
# unique display names
dev_tok = http("/v2/account/authenticate/device?create=true", {"id": "smoke-device-" + stamp}, basic=True).get("token", "")
c2 = Client(dev_tok, "device")
uid2 = startup(c2, "Device", "")
r = c2.call("ChangeUserDetailsRequest", {"displayName": name.lower()}); check(r.get("error") == {"displayName": "already set"}, "duplicate name rejected (case-insens): %s" % r)
r = c2.call("ChangeUserDetailsRequest", {"displayName": "Dev" + stamp[-6:]}); check("error" not in r, "set name: %s" % r)
r = c2.call("AccountDetailsRequest"); check(r.get("displayName") == "Dev" + stamp[-6:], "name persisted")
r = c1.call("ChangeUserDetailsRequest", {"displayName": "Dev" + stamp[-6:]}); check(r.get("error") == {"displayName": "already set"}, "duplicate name rejected 2")
r = c1.call("ChangeUserDetailsRequest", {"displayName": "Renamed" + stamp[-6:]}); check("error" not in r, "rename")
r = c2.call("ChangeUserDetailsRequest", {"displayName": name}); check("error" not in r, "released name can be reused: %s" % r)

# --- ACCOUNT_DELETE_REQUEST: throwaway device user owning a name, profile, season record, guild (with c2) and lobby (with c2) ---
print("== delete")
CONSOLE = os.environ.get("NAKAMA_CONSOLE", "http://127.0.0.1:7351")
def console(path, body=None, token=None, method="GET"):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(CONSOLE + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return {"http_error": e.code}
dev3 = "smoke-delete-" + stamp
tok3 = http("/v2/account/authenticate/device?create=true", {"id": dev3}, basic=True).get("token", "")
c3 = Client(tok3, "delete")
uid3 = c3.call("AccountDetailsRequest").get("userId", "")
dname = "Del" + stamp[-6:]
c3.ok("ChangeUserDetailsRequest", {"displayName": dname}); c3.ok("META_TUTORIAL_STARTED", {"TUTORIAL_ID": "step1"})
sid = c3.ok("SEASON_GET_SEASONS_DETAILS", {}, ["seasons"])["seasons"][0]["id"]
c3.ok("SEASON_JOIN", {"SEASON_ID": sid, "PAYMENT": 1})
gid = c3.ok("GUILD_CREATE", {"GUILD_NAME": "DelGuild" + stamp[-6:], "GUILD_DESCRIPTION": "", "GUILD_MESSAGE_OF_THE_DAY": ""})["guildData"]["guildId"]
c2.ok("GUILD_JOIN_REQUEST", {"GUILD_ID": gid}); c3.ok("GUILD_ACCEPT_ASPIRANT", {"PLAYER_ID": uid2})
lid = c3.ok("LOBBY_CREATE", {"GAME_INFO": {}}, ["lobbyId"])["lobbyId"]
c3.ok("LOBBY_INVITE", {"LOBBY_ID": lid, "PLAYER_ID": uid2}); c2.ok("LOBBY_ACCEPT", {"LOBBY_ID": lid})
ctok = console("/v2/console/authenticate", {"username": os.environ.get("CONSOLE_USERNAME", "admin"), "password": os.environ.get("CONSOLE_PASSWORD", "catanadmin")}, method="POST").get("token", "")
check(ctok and len(console("/v2/console/storage?user_id=" + uid3, token=ctok).get("objects", [])) > 0, "delete: user has storage before")
r = c3.call("ACCOUNT_DELETE_REQUEST")
check("error" not in r and r.get("scriptData") == {} and r.get("eventKey") == "ACCOUNT_DELETE_REQUEST", "delete: response %s" % r)
check("token" not in http("/v2/account/authenticate/device?create=false", {"id": dev3}, basic=True), "delete: device login still works")
check("token" not in http("/v2/account/authenticate/custom?create=false", {"id": __import__("hashlib").sha256(tok3.encode()).hexdigest()}, basic=True), "delete: token re-login still works")
check(console("/v2/console/account/" + uid3, token=ctok).get("http_error") == 404, "delete: console still finds account")
check(console("/v2/console/storage?user_id=" + uid3, token=ctok).get("objects", []) == [], "delete: storage left")
r = c1.call("ACCOUNT_GET_DETAILS_BY_ID", {"PLAYER_ID": uid3}); check(r.get("error", {}).get("errorCode") == 38, "delete: profile still readable")
lb = c1.ok("SEASON_GET_LEADERBOARD", {"SEASON_ID": sid, "OFFSET": 0, "COUNT": 1000}, ["leaderboard"])["leaderboard"]
check(all(x.get("userId") != uid3 for x in lb), "delete: season record left")
g = c2.ok("GUILD_GET_DETAILS", {}, ["guildData"])["guildData"]
check(g.get("guildId") == gid and g.get("ownerId") == uid2 and g.get("memberIds") == [uid2], "delete: guild not handed to member: %s" % g)
l = c2.ok("LOBBY_GET_GAMEINFO", {"LOBBY_ID": lid}, ["ownerId", "lobbyPlayers"])
check(l["ownerId"] == uid2 and all(p.get("userId") != uid3 for p in l["lobbyPlayers"]), "delete: lobby still has user")
r = c1.call("ChangeUserDetailsRequest", {"displayName": dname}); check("error" not in r, "delete: name not released: %s" % r)
print("FAILED %d" % len(fails) if fails else "ALL OK"); sys.exit(1 if fails else 0)
PY
