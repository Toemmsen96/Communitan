#!/usr/bin/env bash
# Operator password reset (players can't reset in-game: codes would let anyone who knows an email take over).
# usage: tools/reset-password.sh <email> <new-password>     (reads console credentials from server/.env)
set -euo pipefail
EMAIL="${1:?email}"; NEWPW="${2:?new password (min 8 chars)}"
cd "$(dirname "$0")/../server"
[ -f .env ] && { set -a; . ./.env; set +a; }
C="${CONSOLE_URL:-http://127.0.0.1:7351}"
T=$(curl -sf -X POST "$C/v2/console/authenticate" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "${CONSOLE_USERNAME:-admin}" "${CONSOLE_PASSWORD:-catanadmin}")" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
ID=$(curl -sf -G "$C/v2/console/account" --data-urlencode "filter=$EMAIL" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;u=json.load(sys.stdin).get("users") or [];print(u[0]["id"] if len(u)==1 else "")')
[ -n "$ID" ] || { echo "no unique account found for $EMAIL" >&2; exit 1; }
curl -sf -X POST "$C/v2/console/account/$ID" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"password":sys.argv[1]}))' "$NEWPW")" >/dev/null
echo "password updated for $EMAIL ($ID)"
