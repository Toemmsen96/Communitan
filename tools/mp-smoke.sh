#!/usr/bin/env bash
# Two real game clients (headless harness instances 1+2) play an online match against the LOCAL server; the game's
# AI plays both seats (mod cfg Debug.AutoPlay). Waits for the game end (or timeout), optionally kills + relaunches
# instance 2 mid-game (reconnect test), then summarizes both traffic logs, Player.logs and the server log.
# Usage: tools/mp-smoke.sh [--timeout SEC] [--mode QuickMatch|Lobby] [--timescale X] [--reconnect AFTER_SEC] [--keep]
#                         [--summary-only] [--server URL] [--key KEY] [--first N] [--container NAME] [--players N]
#                         [--expansion NAME] [--game-mode ID] [--ui]
#   --reconnect N  N seconds after both clients started the game, kill instance 2, relaunch it, expect a rejoin
#   --keep         leave both games running at the end
#   --summary-only only print the summary of the last run
#   --server URL   another server than Local (instance server list entry "Smoke"), e.g. http://127.0.0.1:17350
#   --first N      harness instances N and N+1 (default 1)
#   --container C  Nakama container for the server log summary (default server_nakama_1)
#   --players N    N clients (instances first..first+N-1, QuickMatch only; default 2)
#   --expansion E  expansion of the quick match (ExpansionsEnum name, e.g. CatanCitiesAndKnights; default base game)
#   --game-mode ID custom game mode of the server (docs/design/game-modes.md, e.g. robbers): QuickMatch = Free Play of the
#                  mode, Lobby = the host picks it; summary checks the mode's dice + round grants on every client
#   --ui           with --game-mode: start it through the menu UI (Free Play mode box / lobby Game mode selector, cfg
#                  Debug.AutoPlayUi). CATAN_SHOTS=1 + HEADLESS_METHOD=gamescope: screenshots in the run dirs
# GAME_DIR=<dir> (env) runs a different game copy, e.g. one whose BepInEx/plugins holds a test build of the mod.
# Needs: Steam running, server up (podman server_nakama_1), tools/build.sh deployed. Never uses the official servers.
set -uo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
source "$TOOLS/common.sh"

TIMEOUT=1500; MODE=QuickMatch; SCALE=1; RECONNECT=0; KEEP=0; ONLY_SUMMARY=0; SERVER=""; KEY=defaultkey; FIRST=1; CONTAINER=server_nakama_1; PLAYERS=2; EXPANSION=CatanBaseGame; GAME_MODE=""; UI=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift ;;
    --mode) MODE="$2"; shift ;;
    --timescale) SCALE="$2"; shift ;;
    --reconnect) RECONNECT="$2"; shift ;;
    --keep) KEEP=1 ;;
    --summary-only) ONLY_SUMMARY=1 ;;
    --server) SERVER="$2"; shift ;;
    --key) KEY="$2"; shift ;;
    --first) FIRST="$2"; shift ;;
    --container) CONTAINER="$2"; shift ;;
    --players) PLAYERS="$2"; shift ;;
    --expansion) EXPANSION="$2"; shift ;;
    --game-mode) GAME_MODE="$2"; shift ;;
    --ui) UI=true ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
I1=$FIRST; I2=$((FIRST + 1)); INSTS=$(seq "$FIRST" $((FIRST + PLAYERS - 1)) | tr '\n' ' ')
STATE="$CACHE_DIR/mp-smoke"; [[ $FIRST == 1 ]] || STATE="$CACHE_DIR/mp-smoke-$FIRST"; mkdir -p "$STATE"
R1="$CACHE_DIR/run-$I1"; R2="$CACHE_DIR/run-$I2"; RUNS=(); for i in $INSTS; do RUNS+=("$CACHE_DIR/run-$i"); done

summary() {
  python3 -I - "$STATE" "${RUNS[@]}" <<'PY'
import json, sys, os, re, collections
state, runs = sys.argv[1], sys.argv[2:]
def load(path):
    out = []
    try:
        for l in open(path, encoding='utf-8', errors='replace'):
            try: out.append(json.loads(l))
            except Exception: pass
    except FileNotFoundError: pass
    return out
def err(d):
    if not isinstance(d, dict): return None
    e = d.get('error')
    if isinstance(e, dict): return e.get('errorCode') or e.get('code') or json.dumps(e)[:60]
    return e
ok_all = True
for rd in runs:
    n = os.path.basename(rd).split('-')[-1]
    t = load(os.path.join(rd, 'traffic.jsonl'))
    c = collections.Counter((x.get('dir'), x.get('id')) for x in t)
    errs = collections.Counter()
    for x in t:
        if x.get('dir') == 'recv' and err(x.get('data')) is not None:
            errs[f"{x.get('id')}:{err(x.get('data'))}"] += 1
    unhandled = sum(1 for x in t if x.get('dir') == 'recv' and isinstance(x.get('data'), dict) and 'UNHANDLED' in json.dumps(x['data']))
    blog = open(os.path.join(rd, 'bepinex.log'), errors='replace').read() if os.path.exists(os.path.join(rd, 'bepinex.log')) else ''
    plog = open(os.path.join(rd, 'Player.log'), errors='replace').read() if os.path.exists(os.path.join(rd, 'Player.log')) else ''
    exc = re.findall(r'^(\w[\w.]*Exception[^\n]{0,120})', plog, re.M)
    ex_top = collections.Counter(exc).most_common(3)
    g = lambda d, i: c.get((d, i), 0)
    # only results for a challenge this client played (persisted pushes of earlier games are re-delivered at login)
    played = {x['data'].get('challengeInstanceId') for x in t if x.get('dir') == 'send' and isinstance(x.get('data'), dict) and x.get('id') in ('GAME_ACTION_V3', 'GAME_PLAYER_HAS_STARTED_GAMELOGIC', 'GAME_PING_V3')}
    played.discard(None)
    won = g('send', 'GAME_WON')
    res = sum(1 for x in t if x.get('id') == 'ScriptMessage:GAME_MULTIPLAYER_RESULT' and ((x.get('data') or {}).get('data') or {}).get('challengeId') in played)
    print(f"[client {n}] matched={g('push','ScriptMessage:MatchFoundMessage')} createChallenge={g('send','CreateChallengeRequest')} "
          f"details={g('recv','GAME_GET_GAME_DETAILS_V3')} startGL={g('push','ScriptMessage:GAME_START_GAMELOGIC')} "
          f"actionsSent={g('send','GAME_ACTION_V3')} actionsRecv={g('push','ScriptMessage:GAME_ACTION_PLAYED')} "
          f"ttSent={g('send','GAME_ACTION_TURNTIMER')} pings={g('send','GAME_PING_V3')} "
          f"rejoinState={g('recv','GAME_GET_GAMESTATE_AND_ACTIONS_V3')} returned={g('send','GAME_PLAYER_RETURNED')} "
          f"GAME_WON sent={won} RESULT recv={res} wonByServer={g('push','ScriptMessage:GAME_WON_BY_SERVER')}")
    print(f"           milestones: started={blog.count('AutoPlay game started')} "
          f"aiAttached={blog.count('AI controller attached')}; errors={dict(errs) or 0} unhandled={unhandled}; "
          f"exceptions={len(exc)} {[f'{k[:90]} x{v}' for k, v in ex_top]}")
    if res == 0: ok_all = False
# server dice (CATAN_SERVER_RNG=full, mod log): RNG state after each word mix must match across clients (desync check)
mixes = []
for rd in runs:
    blog = open(os.path.join(rd, 'bepinex.log'), errors='replace').read() if os.path.exists(os.path.join(rd, 'bepinex.log')) else ''
    m = {}
    # compare at sequential points only: inside a context all players act at once (discards) and the order differs
    for uid, act, rng in re.findall(r'ServerRng: mix #\d+ uid=(\d+) act=(\S+) rng=(\S+)', blog):
        if act in ('Base_RollDice', 'Cak_RollDice', 'Base_EndTurn'): m.setdefault(uid, set()).add(rng)
    rolls = re.findall(r'ServerRng: roll uid=\d+ local=\[([\d,]*)\] server=\[([\d,]*)\]', blog)
    mixes.append(m)
    if m or rolls:
        print(f"[client {os.path.basename(rd).split('-')[-1]}] server dice: own rolls={len(rolls)} changed by server={sum(1 for l, s in rolls if l != s)}; "
              f"checked rolls/turn ends={len(m)} draws={blog.count('ServerRng: ') - blog.count('ServerRng: mix') - len(rolls)}")
if any(mixes):
    common = set.intersection(*[set(m) for m in mixes]) if all(mixes) else set()
    bad = [u for u in common if len(set.union(*[m[u] for m in mixes])) != 1]
    print(f"[rng] rolls/turn ends seen on every client: {len(common)}, RNG state mismatches: {len(bad)} {sorted(bad, key=int)[:5]}")
    if bad: ok_all = False
# game modes (mod log, harness only): every applied roll + every round grant; grants must be identical on every client
grants_by = []
for rd in runs:
    blog = open(os.path.join(rd, 'bepinex.log'), errors='replace').read() if os.path.exists(os.path.join(rd, 'bepinex.log')) else ''
    mode = re.findall(r'GameModes: challenge \S+ plays mode (.+)', blog)
    rolls = [tuple(map(int, d.split(','))) for d in re.findall(r'Modes: roll turn=-?\d+ dice=\[([\d,]+)\]', blog)]
    g = {}
    for turn, txt in re.findall(r'Modes: round grant turn=(-?\d+) next=\d+: (.*)', blog):
        g.setdefault(int(turn), set()).add(txt.strip())
    grants_by.append(g)
    if mode or rolls or g:
        sums = collections.Counter(a + b for a, b in rolls)
        per = [len(re.findall(r'p\d+=\[([^\]]*)\]', next(iter(v)))) for v in g.values()]
        cards = collections.Counter(len(x.split(',')) for v in g.values() for x in re.findall(r'p\d+=\[([^\]]*)\]', next(iter(v))))
        print(f"[client {os.path.basename(rd).split('-')[-1]}] mode: {mode[-1] if mode else '?'}; rolls applied={len(rolls)} sums={dict(sums)}; "
              f"round grants={len(g)} (players per grant {sorted(set(per))}, cards per player {dict(cards)}); conflicting grants for one turn={sum(1 for v in g.values() if len(v) > 1)}")
if any(grants_by):
    common = set.intersection(*[set(g) for g in grants_by]) if all(grants_by) else set()
    bad = [t for t in common if len(set.union(*[g[t] for g in grants_by])) != 1]
    print(f"[modes] round grants seen on every client: {len(common)}, differing between clients: {len(bad)} {sorted(bad)[:5]}")
    if bad: ok_all = False
print("RESULT: " + ("PASS (every client got GAME_MULTIPLAYER_RESULT)" if ok_all else "INCOMPLETE (no result on at least one client)"))
open(os.path.join(state, 'result'), 'w').write('PASS' if ok_all else 'FAIL')
PY
  if [[ -f "$STATE/since" ]]; then
    local since; since=$(cat "$STATE/since")
    local srv; srv=$(podman logs --since "$since" "$CONTAINER" 2>&1 | grep -E '"level":"(error|warn)"|UNHANDLED' | grep -vE 'websocket|Error reading message|connection reset' )
    echo "[server] errors/warnings since start: $(printf '%s' "$srv" | grep -c . ) ; UNHANDLED ids: $(printf '%s' "$srv" | grep -o 'UNHANDLED[^"]*' | sort | uniq -c | sort -rn | head -5 | tr '\n' ' ')"
    printf '%s\n' "$srv" | grep -v UNHANDLED | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -5
  fi
}

if [[ $ONLY_SUMMARY == 1 ]]; then summary; exit 0; fi

podman ps --format '{{.Names}}' | grep -qx "$CONTAINER" || { echo "$CONTAINER not running" >&2; exit 1; }
# The instances never write the user's cfg/servers.json (own files via CATAN_* env); verify + restore anyway.
USER_CFG="$PLUGIN_CFG"; USER_LIST="$SERVER_LIST"
for f in "$USER_CFG" "$USER_LIST"; do [[ -f "$f" ]] && cp -p "$f" "$STATE/$(basename "$f").bak"; done
cleanup() {
  [[ $KEEP == 1 ]] || for i in $INSTS; do "$TOOLS/stop-game.sh" --instance $i >/dev/null; done
  for f in "$USER_CFG" "$USER_LIST"; do
    b="$STATE/$(basename "$f").bak"
    [[ -f "$b" ]] && ! cmp -s "$b" "$f" && { cp -p "$b" "$f"; echo "restored $f"; }
  done
}
trap cleanup EXIT

for i in $INSTS; do "$TOOLS/stop-game.sh" --instance $i >/dev/null; done
SERVER_NAME=Local
if [[ -n "$SERVER" ]]; then
  [[ "$SERVER" == *://* ]] || SERVER="http://$SERVER"
  [[ "${SERVER#*://}" == *:* ]] || SERVER="$SERVER:7350"
  SERVER_NAME=Smoke
fi
for i in $INSTS; do
  mkdir -p "$CACHE_DIR/run-$i"; rm -f "$CACHE_DIR/run-$i/traffic.jsonl" "$CACHE_DIR/run-$i/bepinex.log"
  if [[ -n "$SERVER" ]]; then # instance server list entry "Smoke" -> --server (the user's list is never touched)
    H="${SERVER#*://}"
    python3 -I - "$CACHE_DIR/run-$i/servers.json" "${SERVER%%://*}" "${H%:*}" "${H##*:}" "$KEY" <<'PY'
import json, sys
path, scheme, host, port, key = sys.argv[1:]
try: d = json.load(open(path))
except Exception: d = {"servers": []}
d["servers"] = [s for s in d.get("servers", []) if s.get("Name") != "Smoke"] + [
    {"Name": "Smoke", "Host": host, "Port": int(port), "Scheme": scheme, "ServerKey": key, "LegacyDeviceId": True}]
d["selected"] = "Smoke"
json.dump(d, open(path, "w"), indent=2)
PY
  fi
  # durable request queue of earlier runs (would replay e.g. a stale MatchmakingRequest)
  rm -f "$CACHE_DIR/prefix-$i/pfx/drive_c/users/steamuser/AppData/LocalLow/United Soft Media Verlag GmbH/Catan Universe/"gs_default_*.dat
done
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE/since"
# --mode Lobby: instance 1 hosts a custom lobby and invites instance 2 (user id via CATAN_INVITE_FILE)
export CATAN_INVITE_FILE="$STATE/invite-id"; rm -f "$CATAN_INVITE_FILE"
mode_of() { if [[ $MODE == Lobby ]]; then [[ $1 == $I1 ]] && echo HostLobby || echo JoinLobby; else echo "$MODE"; fi; }
launch() { "$TOOLS/run-game.sh" --instance "$1" --headless --server "$SERVER_NAME" \
  --cfg Debug.AutoPlay="$(mode_of "$1")" --cfg Debug.AutoPlayPlayers="$PLAYERS" --cfg Debug.AutoPlayExpansion="$EXPANSION" --cfg Debug.AutoPlayMode="$GAME_MODE" --cfg Debug.AutoPlayUi="$UI" --cfg Debug.AutoPlayTimeScale="$SCALE" --cfg Debug.TrafficLog=true --cfg Debug.UnityLog=true | head -1; }
for i in $INSTS; do launch $i; done

alive() { [[ -f "$CACHE_DIR/run-$1/game.pid" ]] && kill -0 "$(cat "$CACHE_DIR/run-$1/game.pid")" 2>/dev/null; }
has() { grep -q "$2" "$CACHE_DIR/run-$1/$3" 2>/dev/null; }
# a GAME_MULTIPLAYER_RESULT after this client started a game (earlier persisted results are re-delivered at login)
result_after_start() { sed -n '/"GAME_PLAYER_HAS_STARTED_GAMELOGIC"/,$p' "$CACHE_DIR/run-$1/traffic.jsonl" 2>/dev/null | grep -q GAME_MULTIPLAYER_RESULT; }
START=$(date +%s); STARTED_AT=0; RECONNECTED=0; LAST=""
while :; do
  now=$(date +%s); el=$((now - START))
  all=1; for i in $INSTS; do result_after_start $i || all=0; done
  if [[ $all == 1 ]]; then echo "[$el s] all clients received GAME_MULTIPLAYER_RESULT"; sleep 5; break; fi
  (( el > TIMEOUT )) && { echo "[$el s] timeout"; break; }
  for i in $INSTS; do alive $i || { [[ $RECONNECTED == 1 && $i == $I2 ]] || echo "[$el s] instance $i exited"; }; done
  ing=1; for i in $INSTS; do has $i 'AutoPlay game started' bepinex.log || ing=0; done
  if [[ $STARTED_AT == 0 && $ing == 1 ]]; then
    STARTED_AT=$now; echo "[$el s] all clients in game"
  fi
  if [[ $RECONNECT -gt 0 && $RECONNECTED == 0 && $STARTED_AT -gt 0 && $((now - STARTED_AT)) -ge $RECONNECT ]]; then
    echo "[$el s] reconnect test: killing instance $I2"
    cp "$R2/traffic.jsonl" "$STATE/traffic-2-before-kill.jsonl" 2>/dev/null
    "$TOOLS/stop-game.sh" --instance $I2 >/dev/null; sleep 5; launch $I2; RECONNECTED=1
  fi
  st=""; for i in $INSTS; do st="$st$(grep -c GAME_ACTION_V3 "$CACHE_DIR/run-$i/traffic.jsonl" 2>/dev/null)/"; done
  if [[ "$st" != "$LAST" && $((el % 60)) -lt 10 ]]; then echo "[$el s] action lines ($INSTS): $st"; LAST="$st"; fi
  sleep 10
done
if [[ $RECONNECTED == 1 ]]; then
  echo "[reconnect] relaunched client 2: GET_CURRENT_SESSION=$(grep -c '"dir":"send","id":"GAME_GET_CURRENT_SESSION"' "$R2/traffic.jsonl") GAMESTATE_AND_ACTIONS_V3=$(grep -c '"dir":"recv","id":"GAME_GET_GAMESTATE_AND_ACTIONS_V3"' "$R2/traffic.jsonl") PLAYER_RETURNED=$(grep -c '"dir":"send","id":"GAME_PLAYER_RETURNED"' "$R2/traffic.jsonl") actionsSentAfterRelaunch=$(( $(grep -c '"dir":"send","id":"GAME_ACTION_V3"' "$R2/traffic.jsonl") - $(grep -c '"dir":"send","id":"GAME_ACTION_V3"' "$STATE/traffic-2-before-kill.jsonl") ))"
fi
summary
[[ "$(cat "$STATE/result" 2>/dev/null)" == PASS ]]
