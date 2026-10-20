#!/usr/bin/env python3
"""StreamingAssets/Almanac of YOUR game install (base64 thrift-binary Almanac) -> server/data/almanac.json (ALMANAC_GET_DATA).
The almanac is USM's text, so the file is not in the repo or the release zip (.gitignore). Optional: without it the server reports
almanacVersion 0 and players keep the almanac their game already has (content.ts). The bundled almanac is English: the server
serves it only to clients whose language matches `language`; everyone else keeps their own.
usage: tools/gen-almanac.py [game_data_dir]   (default: Steam install under ~/.local/share/Steam; on Windows pass
       "C:/Program Files (x86)/Steam/steamapps/common/Catan Universe/CatanUniverse_Data")"""
import base64, json, os, struct, sys

GAME = os.path.expanduser("~/.local/share/Steam/steamapps/common/Catan Universe/CatanUniverse_Data")
GAME = sys.argv[1] if len(sys.argv) > 1 else GAME
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
# repo: server/data; release zip (communitan-server-<v>/tools/gen-almanac.py): data/. Restart the server afterwards.
OUT = os.path.join(next((d for d in (os.path.join(ROOT, "server", "data"), os.path.join(ROOT, "data")) if os.path.isdir(d)), ROOT), "almanac.json")
GAMETYPES = ["Catan", "Rivals"]  # Common.GameLogic.Model/GameType.cs

def read(buf, pos, t):
    if t == 2 or t == 3: return buf[pos], pos + 1
    if t == 4: return struct.unpack(">d", buf[pos:pos+8])[0], pos + 8
    if t == 6: return struct.unpack(">h", buf[pos:pos+2])[0], pos + 2
    if t == 8: return struct.unpack(">i", buf[pos:pos+4])[0], pos + 4
    if t == 10: return struct.unpack(">q", buf[pos:pos+8])[0], pos + 8
    if t == 11:
        n = struct.unpack(">i", buf[pos:pos+4])[0]; pos += 4
        return buf[pos:pos+n].decode("utf-8"), pos + n
    if t == 12:
        d = {}
        while True:
            ft = buf[pos]; pos += 1
            if ft == 0: return d, pos
            fid = struct.unpack(">h", buf[pos:pos+2])[0]; pos += 2
            d[fid], pos = read(buf, pos, ft)
    if t in (14, 15):
        et = buf[pos]; n = struct.unpack(">i", buf[pos+1:pos+5])[0]; pos += 5
        out = []
        for _ in range(n):
            v, pos = read(buf, pos, et); out.append(v)
        return out, pos
    raise ValueError("thrift type %d" % t)

raw = base64.b64decode(open(os.path.join(GAME, "StreamingAssets", "Almanac")).read())
alm, _ = read(raw, 0, 12)
cats = []
for c in alm.get(1, []):
    e = [{"id": x.get(3, ""), "headline": x.get(1, ""), "content": x.get(2, "")} for x in c.get(2, [])]
    cat = {"category": c.get(1, ""), "sortEntries": bool(c.get(5, 1)), "entries": e}
    if 4 in c: cat["gameTypes"] = [GAMETYPES[g] for g in c[4]]
    cats.append(cat)
json.dump({"almanacVersion": alm.get(2, 1) or 1, "language": alm.get(3) or "en", "almanac": cats}, open(OUT, "w"), ensure_ascii=False, indent=1)
print(os.path.normpath(OUT) + ": categories", len(cats), "entries", sum(len(c["entries"]) for c in cats), "version", alm.get(2), "lang", alm.get(3))
