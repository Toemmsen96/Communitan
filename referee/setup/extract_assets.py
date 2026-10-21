#!/usr/bin/env python3
# Referee setup (tools/referee-setup.sh): reads the operator's own game install, writes into <out>/ (git-ignored):
#   assets/shufflemodes.json            {scenarioId: {mode, expansions[]}} from the ScenarioSetup ScriptableObjects
#                                        (Common.Unity/ScenarioSetup.cs: expansions, isFreeMatch, scenarioId, mapShuffleMode, headerTextKey)
#   assets/rules/CatanGameRules.txt      TextAsset rules/catan/CatanGameRules (Catan.GameLogic.Rules/CatanGameRulesSerializer.cs:18)
#   assets/scenarios/catan/<id>.txt     TextAsset scenarios/catan/<id> of every base-game scenario (Common.GameLogic.Model/CommonGameStateSerializer.cs:208)
# Heuristic Unity serialized-file reader (no UnityPy): len-prefixed, 4-aligned strings. Usage: extract_assets.py <CatanUniverse_Data> <out>
import glob, json, os, re, struct, sys

BASE_GAME = 1  # Common.Net/ExpansionsEnum.cs CatanBaseGame
ID_RE = re.compile(rb'([\x03-\x40])\x00\x00\x00([A-Za-z][A-Za-z0-9_]{2,63})')
B64_RE = re.compile(rb'[A-Za-z0-9+/=\s]+')

def i32(d, p):
    return struct.unpack_from('<i', d, p)[0] if 0 <= p and p + 4 <= len(d) else None

def lstr(d, p):  # (string, end aligned) or (None, p)
    n = i32(d, p)
    if n is None or not (0 < n <= 128) or p + 4 + n > len(d):
        return None, p
    s = d[p + 4:p + 4 + n]
    if not re.fullmatch(rb'[A-Za-z0-9_.\-]+', s):
        return None, p
    return s.decode(), (p + 4 + n + 3) & ~3

def scenario_setups(d):
    for m in ID_RE.finditer(d):
        n = m.group(1)[0]
        if len(m.group(2)) < n:
            continue
        start = m.start()
        sid, end = lstr(d, start)
        if sid is None:
            continue
        mode = i32(d, end)
        hdr, _ = lstr(d, end + 4)
        if mode is None or not (0 <= mode <= 32) or hdr is None:
            continue
        free = i32(d, start - 4)
        if free not in (0, 1):
            continue
        for k in range(1, 9):  # expansions list: count k, then k enum values
            if i32(d, start - 8 - 4 * k) == k:
                ex = [i32(d, start - 4 - 4 * k + 4 * j) for j in range(k)]
                if all(e and e > 0 and e & (e - 1) == 0 and e <= 0x100000 for e in ex):
                    yield sid, mode, ex, bool(free), hdr
                break

def text_asset(d, name):
    nb = name.encode()
    hits = []
    for m in re.finditer(re.escape(struct.pack('<i', len(nb)) + nb), d):
        p = (m.end() + 3) & ~3
        ln = i32(d, p)
        if ln and 16 < ln < 50_000_000 and p + 4 + ln <= len(d):
            body = d[p + 4:p + 4 + ln]
            if B64_RE.fullmatch(body):
                hits.append(body)
    return hits

def main():
    data, out = sys.argv[1], sys.argv[2]
    files = sorted(glob.glob(os.path.join(data, '*.assets'))) + sorted(glob.glob(os.path.join(data, 'level[0-9]*')))
    files = [f for f in files if not f.endswith('.resS')]
    modes = {}
    for f in files:
        d = open(f, 'rb').read()
        for sid, mode, ex, free, hdr in scenario_setups(d):
            cur = modes.get(sid)
            if cur and (cur['mode'] != mode or cur['expansions'] != ex):
                print(f'WARN scenario {sid}: conflicting setups {cur} vs mode={mode} ex={ex} ({os.path.basename(f)})')
                continue
            modes[sid] = {'mode': mode, 'expansions': ex}
    if not modes:
        sys.exit('no ScenarioSetup records found (unexpected game version?)')
    os.makedirs(os.path.join(out, 'assets', 'rules'), exist_ok=True)
    os.makedirs(os.path.join(out, 'assets', 'scenarios', 'catan'), exist_ok=True)
    res = open(os.path.join(data, 'resources.assets'), 'rb').read()
    want = {'rules/CatanGameRules.txt': 'CatanGameRules'}
    for sid, v in sorted(modes.items()):
        if v['expansions'] == [BASE_GAME] and 'tutorial' not in sid.lower():
            want['scenarios/catan/' + sid + '.txt'] = sid
    written = []
    for rel, name in want.items():
        hits = text_asset(res, name)
        if len(hits) != 1:
            print(f'WARN TextAsset {name}: {len(hits)} candidates, skipped')
            continue
        open(os.path.join(out, 'assets', rel), 'wb').write(hits[0])
        written.append(rel)
    json.dump(modes, open(os.path.join(out, 'assets', 'shufflemodes.json'), 'w'), indent=1, sort_keys=True)
    print(f'scenario setups: {len(modes)} ({sum(1 for v in modes.values() if v["expansions"] == [BASE_GAME])} base game); text assets: {", ".join(written)}')
    if 'rules/CatanGameRules.txt' not in written:
        sys.exit('CatanGameRules not found')

if __name__ == '__main__':
    main()
