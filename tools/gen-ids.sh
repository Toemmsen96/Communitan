#!/usr/bin/env bash
# Regenerates the registerRpc block in server/src/main.ts from the decomp's GameSparks request classes
# (every id the client can send; unimplemented ones answer empty success + log UNHANDLED).
set -euo pipefail
DECOMP="${DECOMP:-$HOME/Documents/Decomps/Catan}"
MAIN="$(dirname "$0")/../server/src/main.ts"
R="$DECOMP/GameSparks.Api.Requests"
IDS=$( { ls "$R" | grep -E '^Log(Challenge)?EventRequest_' | sed -E 's/^Log(Challenge)?EventRequest_//;s/\.cs$//'
         ls "$R" | grep -vE '^Log(Challenge)?EventRequest' | sed 's/\.cs$//' | grep 'Request$'; } | sort -u)
python3 - "$MAIN" <<PY
import sys,re
p=sys.argv[1]; s=open(p).read()
ids="""$IDS""".split()
block="".join('    initializer.registerRpc("%s", rpcDispatch);\n' % i for i in ids)
s=re.sub(r'(    // BEGIN GENERATED RPCS[^\n]*\n).*?(    // END GENERATED RPCS)', lambda m: m.group(1)+block+m.group(2), s, flags=re.S)
open(p,'w').write(s); print("registered %d ids in %s" % (len(ids), p))
PY
