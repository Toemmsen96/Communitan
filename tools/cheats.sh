#!/usr/bin/env bash
# Operator view of the referee's cheat records (CATAN_SERVER_RULES=audit|enforce, docs/design/level3-referee.md):
# storage collection l3_cheats, one object per (player, game), newest first.
# usage: tools/cheats.sh [max]     (default 50; console credentials from server/.env; another server: CONSOLE_URL +
#        CONSOLE_USERNAME/CONSOLE_PASSWORD, .env is then not read)
set -euo pipefail
MAX="${1:-50}"
cd "$(dirname "$0")/../server"
[ -z "${CONSOLE_URL:-}" ] && [ -f .env ] && { set -a; . ./.env; set +a; }
C="${CONSOLE_URL:-http://127.0.0.1:7351}"
T=$(curl -sf -X POST "$C/v2/console/authenticate" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "${CONSOLE_USERNAME:-admin}" "${CONSOLE_PASSWORD:-catanadmin}")" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
python3 -I - "$C" "$T" "$MAX" <<'PY'
import json, sys, time, urllib.parse, urllib.request
base, token, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
def get(path):
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
rows, cursor = [], ""
while True:
    q = {"collection": "l3_cheats"}
    if cursor: q["cursor"] = cursor
    page = get("/v2/console/storage?" + urllib.parse.urlencode(q))
    rows += page.get("objects") or []
    cursor = page.get("next_cursor") or ""
    if not cursor: break
# The list carries no values: newest MAX by update time, then one read each.
rows.sort(key=lambda o: o.get("update_time", ""), reverse=True)
recs = []
for o in rows[:limit]:
    path = "/v2/console/storage/l3_cheats/%s/%s" % (urllib.parse.quote(o["key"], safe=""), o["user_id"])
    try: v = json.loads(get(path).get("value") or "{}")
    except (ValueError, OSError): v = {}
    recs.append((v.get("at") or 0, o["user_id"], o["key"], v))
if not recs:
    print("no cheat records"); sys.exit(0)
names = {}
def name(uid):
    if uid not in names:
        try: names[uid] = get("/v2/console/account/" + uid)["account"]["user"]["username"]
        except Exception: names[uid] = "?"
    return names[uid]
print(f"{len(rows)} cheat record(s), newest {len(recs)} shown")
for at, uid, game, v in recs:
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(at / 1000)) if at else "?"
    kind = "mid-game kick" if v.get("inline") else "after the game"
    print(f"{when}  {name(uid)} ({uid})  game {game}  {kind}")
    print(f"    seat {v.get('seat')}, action uid {v.get('uid')} {v.get('actionId')}: {v.get('reason')}")
PY
