#!/usr/bin/env bash
# Quick manual RPC against the local server as a throwaway device user.
# usage: tools/rpc.sh <ID> ['{"extra":"fields"}'] [device-id]
set -euo pipefail
HOST="${NAKAMA_HOST:-http://127.0.0.1:7350}"
ID="$1"; EXTRA="${2:-{\}}"; DEV="${3:-rpc-sh-device-0001}"
TOK=$(curl -sf -u "${NAKAMA_SERVER_KEY:-defaultkey}:" -X POST "$HOST/v2/account/authenticate/device?create=true" \
  -H 'Content-Type: application/json' -d "{\"id\":\"$DEV\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
BODY=$(python3 -c '
import json,sys
id,extra=sys.argv[1],json.loads(sys.argv[2])
cls = "."+id if id.endswith("Request") else ".LogEventRequest"
req = {"@class":cls,"requestId":"rpc-sh-1"}
if not id.endswith("Request"): req["eventKey"]=id
req.update(extra); print(json.dumps(json.dumps(req)))' "$ID" "$EXTRA")
curl -s -X POST "$HOST/v2/rpc/$ID" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$BODY" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r.get("payload",r))'
