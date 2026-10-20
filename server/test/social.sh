#!/usr/bin/env bash
# Social test (friends, block, guild, mail, whisper, pushes) with 3 fresh device users. usage: server/test/social.sh
exec python3 - "$@" <<'PY'
import base64, json, os, sys, time, urllib.request, urllib.error
HOST = os.environ.get("NAKAMA_HOST", "http://127.0.0.1:7350")
fails = []
def http(path, body=None, token=None, basic=False, method="POST"):
    h = {"Content-Type": "application/json"}
    h["Authorization"] = ("Basic " + base64.b64encode((os.environ.get("NAKAMA_SERVER_KEY", "defaultkey") + ":").encode()).decode()) if basic else ("Bearer " + token)
    req = urllib.request.Request(HOST + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return {"http_error": e.code, "body": e.read().decode()}
def check(cond, msg):
    if not cond: fails.append(msg); print("  FAIL:", msg)
class C:
    def __init__(s, label):
        s.label, s.n = label, 0
        r = http("/v2/account/authenticate/device?create=true", {"id": "social-%s-%d" % (label, time.time_ns())}, basic=True)
        s.token = r["token"]; s.id = json.loads(base64.urlsafe_b64decode(s.token.split(".")[1] + "==="))["uid"]
        s.name = "Soc%s%d" % (label, time.time_ns() % 10**8)
        s.call("ACCOUNT_LOGIN", {"AUTHENTICATION_TYPE": "Device"})
        s.call("ChangeUserDetailsRequest", {"displayName": s.name})
    def call(s, id_, extra=None):
        s.n += 1
        req = {"@class": "." + id_ if id_.endswith("Request") else ".LogEventRequest", "requestId": "t%d" % s.n}
        if not id_.endswith("Request"): req["eventKey"] = id_
        req.update(extra or {})
        r = http("/v2/rpc/" + id_, json.dumps(req), s.token)
        if "payload" not in r: check(False, "%s %s rpc error %s" % (s.label, id_, r)); return {}
        return json.loads(r["payload"])
    def ok(s, id_, extra=None):
        r = s.call(id_, extra); check("error" not in r, "%s %s error %s" % (s.label, id_, r.get("error")))
        check(isinstance(r.get("scriptData"), dict), "%s %s scriptData" % (s.label, id_)); return r.get("scriptData") or {}
    def pushes(s):
        r = http("/v2/notification?limit=100", token=s.token, method="GET")
        out = [json.loads(n["content"]) if isinstance(n["content"], str) else n["content"] for n in r.get("notifications", [])]
        if r.get("notifications"):
            http("/v2/notification?" + "&".join("ids=" + n["id"] for n in r["notifications"]), token=s.token, method="DELETE")
        return [(m.get("extCode") or m.get("@class").lstrip("."), m) for m in out if "@class" in m]
def codes(ps): return [p[0] for p in ps]
A, B, Cc = C("A"), C("B"), C("C")
for u in (A, B, Cc): u.pushes()

print("== friends")
r = A.ok("FRIEND_FIND_PLAYER_BY_NAME", {"DISPLAYNAME": B.name[:8]}); check(B.id in [p["userId"] for p in r["players"]], "find by prefix")
check(A.ok("CHAT_GET_PLAYER_ID", {"PLAYER_NAME": B.name.lower()})["playerId"] == B.id, "CHAT_GET_PLAYER_ID")
A.ok("FRIEND_REQUEST_FRIENDSHIP", {"USER_ID": B.id})
p = B.pushes(); check(codes(p) == ["FRIEND_FRIENDSHIP_REQUESTED"], "B push requested %s" % codes(p))
check(p and p[0][1]["data"]["displayName"] == A.name, "requested push has profile")
lb = B.call("ListGameFriendsRequest"); check([x["id"] for x in lb["scriptData"]["playersRequestingFriendshipFromMe"]] == [A.id], "B incoming")
la = A.call("ListGameFriendsRequest"); check([x["id"] for x in la["scriptData"]["playersIRequestedForFriendship"]] == [B.id], "A outgoing")
B.ok("FRIEND_ACCEPT_FRIENDSHIP", {"USER_ID": A.id})
check(codes(A.pushes()) == ["FRIEND_FRIENDSHIP_ACCEPTED"], "A push accepted")
check([x["id"] for x in A.call("ListGameFriendsRequest")["friends"]] == [B.id], "A friends")
check([x["id"] for x in B.call("ListGameFriendsRequest")["friends"]] == [A.id], "B friends")
check(A.ok("GET_BLOCKED_AND_FRIEND_IDS") == {"blocked": [], "friends": [B.id]}, "friend ids")
check(len(A.call("FRIEND_GET_ONLINE")["friendOnlineStatus"]) == 1, "online status")
Cc.ok("FRIEND_REQUEST_FRIENDSHIP", {"USER_ID": A.id}); A.pushes()
A.ok("FRIEND_DECLINE_FRIENDSHIP", {"USER_ID": Cc.id}); check(codes(Cc.pushes()) == ["FRIEND_FRIENDSHIP_DECLINED"], "C push declined")
check(A.call("ListGameFriendsRequest")["scriptData"]["playersRequestingFriendshipFromMe"] == [], "decline clears")

print("== block")
r = A.ok("BLACKLIST_BLOCK_PLAYER", {"PLAYER_ID": Cc.id}); check([x["id"] for x in r["blockedPlayers"]] == [Cc.id], "blocked list")
check(A.ok("GET_BLOCKED_AND_FRIEND_IDS")["blocked"] == [Cc.id], "blocked ids")
Cc.ok("FRIEND_REQUEST_FRIENDSHIP", {"USER_ID": A.id}); check(A.pushes() == [], "blocked request hidden")
check(A.call("ListGameFriendsRequest")["scriptData"]["playersRequestingFriendshipFromMe"] == [], "blocked request not listed")
Cc.ok("CHAT_SEND_TO_PLAYER_ID", {"PLAYER_ID": A.id, "MESSAGE": "hi"}); check(A.pushes() == [], "blocked whisper hidden")
check(A.ok("BLACKLIST_GET_BLOCKED_PLAYERS")["blockedPlayers"][0]["displayName"] == Cc.name, "blocked has profile")
check(A.ok("BLACKLIST_UNBLOCK_PLAYER", {"PLAYER_ID": Cc.id})["blockedPlayers"] == [], "unblock")
Cc.pushes()

print("== whisper")
A.ok("CHAT_SEND_TO_PLAYER_ID", {"PLAYER_ID": B.id, "MESSAGE": "yo"})
p = B.pushes(); check(codes(p) == ["TeamChatMessage"] and p[0][1]["teamType"] == "PLAYER_CHAT" and p[0][1]["message"] == "yo" and p[0][1]["fromId"] == A.id, "B whisper")
A.pushes()  # echo is non-persistent: not observable without a socket

print("== mail")
m = A.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 0}); check(m["lastIndex"] == 0 and m["messages"] == [], "no system mail (welcome is SERVERNEWS) %s" % m)
body = json.dumps({"subject": "Hey", "message": "text", "date": 1})
A.ok("SendFriendMessageRequest", {"friendIds": [B.id], "message": body}) if False else None
r = A.call("SendFriendMessageRequest", {"friendIds": [B.id], "message": body}); check("error" not in r, "send mail")
p = B.pushes(); check(codes(p) == ["FriendMessage"] and p[0][1]["fromId"] == A.id and p[0][1]["who"] == A.name, "FriendMessage push %s" % codes(p))
m = B.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 0}); check(len(m["messages"]) == 1 and m["lastIndex"] == 1, "B inbox")
mid = [x for x in m["messages"] if x["fromId"] == A.id][0]["messageId"]
check(len(B.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 1})["messages"]) == 0, "index filter")
B.ok("MAIL_READ_MAIL", {"MESSAGE_ID": mid}); check([x for x in B.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 0})["messages"] if x["messageId"] == mid][0]["alreadyRead"], "read flag")
B.ok("MAIL_REMOVE_MAIL", {"MESSAGE_ID": mid}); check(len(B.ok("MAIL_GET_LATEST_MAILS", {"INDEX": 0})["messages"]) == 0, "removed")
B.ok("MAIL_REMOVE_MAIL", {"MESSAGE_ID": "outgoing_1"})

print("== guild")
gname = "Guild%d" % (time.time_ns() % 10**8)
check("invalid_guild_name" in A.ok("GUILD_CREATE", {"GUILD_NAME": "x", "GUILD_DESCRIPTION": "", "GUILD_MESSAGE_OF_THE_DAY": ""}), "short name")
g = A.ok("GUILD_CREATE", {"GUILD_NAME": gname, "GUILD_DESCRIPTION": "d", "GUILD_MESSAGE_OF_THE_DAY": "m"})["guildData"]
gid = g["guildId"]; check(g["ownerId"] == A.id and g["memberIds"] == [A.id] and g["aspirantIds"] == [] and g["guildMessageOfTheDay"] == "m", "create %s" % g)
check(A.call("AccountDetailsRequest")["scriptData"]["guildName"] == gname, "AccountDetails guildName")
check(B.ok("GUILD_CREATE", {"GUILD_NAME": gname})["guildData"].get("error") == "GUILD_ALREADY_EXISTS", "dup name")
check(A.ok("GUILD_CREATE", {"GUILD_NAME": gname + "x"})["guildData"].get("error") == "Already guild member", "already member")
check(any(x["guildId"] == gid for x in B.ok("GUILD_FIND_BY_NAME", {"GUILDNAME": gname[:7], "SKIP": 0})["guilds"]), "find by name")
def sorted_pages(skip=0):
    while True:
        page = B.ok("GUILD_GET_MEMBER_SORTED_LIST", {"SKIP": skip})["guilds"]
        if not page: return
        yield from page; skip += len(page)
check(any(x["guildId"] == gid for x in sorted_pages()), "sorted list")
B.ok("GUILD_JOIN_REQUEST", {"GUILD_ID": gid}); check(codes(A.pushes()) == ["GUILD_NEW_REQUEST"], "owner push new request")
check(B.call("AccountDetailsRequest")["scriptData"].get("aspirantForGuildId") == gid, "aspirantForGuildId")
d = A.ok("GUILD_GET_DETAILS")["guildData"]; check(d["aspirantIds"] == [B.id] and d["aspirants"][0]["displayName"] == B.name, "details aspirants")
Cc.ok("GUILD_JOIN_REQUEST", {"GUILD_ID": gid}); A.pushes()
d = A.ok("GUILD_DECLINE_ASPIRANT", {"PLAYER_ID": Cc.id})["guildData"]; check(d["aspirantIds"] == [B.id], "decline aspirant")
check(codes(Cc.pushes()) == ["GUILD_REQUEST_NOT_ACCEPTED"], "C push not accepted")
d = A.ok("GUILD_ACCEPT_ASPIRANT", {"PLAYER_ID": B.id})["guildData"]; check(d["memberIds"] == [A.id, B.id] or set(d["memberIds"]) == {A.id, B.id}, "accept")
check(codes(B.pushes()) == ["GUILD_REQUEST_ACCEPTED"], "B push accepted")
check(B.ok("GUILD_GET_DETAILS")["guildData"]["guildId"] == gid, "B details")
check(B.ok("GUILD_GET_GUILD_DETAILS_FOR_PLAYER", {"PLAYER_ID": A.id})["guildData"]["guildId"] == gid, "for player")
check(B.call("GUILD_SET_DESCRIPTION", {"DESCRIPTION": "n", "MESSAGE_OF_THE_DAY": "n"}).get("error", {}).get("errorCode") == 31, "member can't set")
A.ok("GUILD_SET_DESCRIPTION", {"DESCRIPTION": "d2", "MESSAGE_OF_THE_DAY": "m2"}); p = B.pushes()
check(codes(p) == ["GUILD_GMOTD_UPDATE"] and p[0][1]["data"]["message"] == "m2", "gmotd push")
check(B.ok("GUILD_GET_DETAILS")["guildData"]["guildMessageOfTheDay"] == "m2", "motd persisted")
A.ok("SendTeamChatMessageRequest", {"teamType": "GUILD", "teamId": gid, "message": "hello guild"})
B.pushes(); A.pushes()  # guild chat push is non-persistent: not observable without a socket
check(B.call("GUILD_LEAVE").get("scriptData") == {}, "leave"); check(codes(A.pushes()) == ["GUILD_REMOVED_PLAYER"], "owner push removed")
check(A.call("GUILD_LEAVE").get("error", {}).get("errorCode") == 20, "owner can't leave")
B.ok("GUILD_JOIN_REQUEST", {"GUILD_ID": gid}); A.pushes(); A.ok("GUILD_ACCEPT_ASPIRANT", {"PLAYER_ID": B.id}); B.pushes()
d = A.ok("GUILD_KICK_PLAYER", {"PLAYER_ID": B.id})["guildData"]; check(d["memberIds"] == [A.id], "kick")
check(codes(B.pushes()) == ["GUILD_GOT_KICKED"], "kicked push")
check(B.ok("GUILD_GET_DETAILS") == {}, "no guild after kick")
B.ok("GUILD_JOIN_REQUEST", {"GUILD_ID": gid}); A.pushes(); A.ok("GUILD_ACCEPT_ASPIRANT", {"PLAYER_ID": B.id}); B.pushes()
A.ok("GUILD_CLOSE"); check(codes(B.pushes()) == ["GUILD_CLOSED"], "closed push")
check(A.ok("GUILD_GET_DETAILS") == {} and B.ok("GUILD_GET_DETAILS") == {}, "no guild after close")

print("== unfriend")
B.ok("FRIEND_DECLINE_FRIENDSHIP", {"USER_ID": A.id}); check(codes(A.pushes()) == ["FRIEND_FRIENDSHIP_DECLINED"], "unfriend push")
check(A.call("ListGameFriendsRequest")["friends"] == [], "unfriended")
print("FAILED %d" % len(fails) if fails else "OK"); sys.exit(1 if fails else 0)
PY
