#!/usr/bin/env python3
"""traffic.jsonl capture -> schema-only copy (same lines, ids, dirs, keys; no USM text).
Kept: keys, booleans, null, small ints (|n| <= 100: flags, counts, levels, enum values), id-like tokens
(no whitespace, <= 64 chars: item ids, categories, @class, eventKey, error codes, asset paths, redaction markers).
Replaced: free text -> "<text>" (any string with whitespace, and every value of a text key such as
displayName/description/Name/headline/content/TOS/AGB), other numbers -> "<num>", ISO dates -> "<date>",
URLs -> "<url>", long tokens -> "<blob>". JSON embedded in strings (scriptData) is converted too.
usage: tools/capture-schema.py <capture.jsonl> > <capture.schema.jsonl>"""
import json, re, sys

TEXT_KEYS = {"displayName", "description", "Description", "Name", "name", "ConditionText", "lockedReason", "headline", "content",
             "title", "text", "TOS", "AGB", "entries", "category", "message", "subject", "customErrorMessage", "nakamaError"}
DATE = re.compile(r"^\d{4}-\d\d-\d\d([T ][\d:.]+Z?([+-]\d\d:?\d\d)?)?$|^\w{3} \w{3} \d\d \d{4} ")
TOKEN = re.compile(r"^[^\s]{0,64}$")


def conv(v, key=None, text=False):
    if isinstance(v, dict):
        return {k: conv(x, k, text) for k, x in v.items()}
    if isinstance(v, list):
        return [conv(x, key, text) for x in v]
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v if isinstance(v, int) and abs(v) <= 100 and not text else "<num>"
    s = str(v)
    if s[:1] in "{[":
        try:
            return json.dumps(conv(json.loads(s), key, text), ensure_ascii=False, separators=(",", ":"))
        except ValueError:
            pass
    if s.startswith(("http://", "https://")):
        return "<url>"
    if DATE.match(s):
        return "<date>"
    # almanac/hint "category"/"entries" are free text, itemDef.category is an enum: keep enum-like tokens there
    if key in TEXT_KEYS and not (key in ("category", "entries", "name") and re.match(r"^[A-Za-z][A-Za-z0-9_]*$", s)):
        return "<text>"
    if text or not TOKEN.match(s):
        return "<text>"
    return s


for line in open(sys.argv[1]):
    r = json.loads(line)
    if "data" in r:
        r["data"] = conv(r["data"])
    print(json.dumps(r, ensure_ascii=False, separators=(",", ":")))
