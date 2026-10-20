# captures/
`prod-startup.schema.jsonl` - official PROD (catan-prod1 Nakama), 2026-10-20, client 2.7.5 (appVersion 94), one fresh Steam/Windows guest (device) account, read-only.
Lines = `tools` traffic log format `{t,dir:send|recv|auth,id,data}`; 45 lines: DeviceAuthenticationRequest + the full startup/main-menu fan-out
(friends, blacklist, promotions, mail, hints, shop incl. categories/products/external/prices, tutorials, news, ITEM_GET_PRODUCT_ITEMS, ACCOUNT_LOGIN, AccountDetails, ALMANAC, seasons, TOS/AGB).

**Schema only.** The responses contain USM's copyrighted content (TOS/AGB, almanac, item and shop texts, news, season texts), so the repo keeps
only the structure, made by `tools/capture-schema.py`: same lines, order, `t`/`dir`/`id`/`rid`, every key; kept values = booleans, null,
small ints (|n| <= 100: flags, counts, levels, enums) and id-like tokens (item/color/product ids, categories, `@class`, `eventKey`,
error codes, asset paths, requestIds). Replaced: free text -> `"<text>"` (also every value of a text key such as displayName,
description, Name, headline, content, TOS, AGB), other numbers (prices, timestamps) -> `"<num>"`, dates -> `"<date>"`, URLs -> `"<url>"`.
JSON embedded in strings (`scriptData` of the auth lines) is converted the same way.

The raw capture stays local: `captures/private/prod-startup.jsonl` (gitignored). Redacted there: user ids -> `<USER_ID_n>`,
device id -> `<DEVICE_ID_n>`, Steam id -> `<STEAM_ID_n>`, generated username -> `<USERNAME_n>`; no session tokens appear in the log.
`tools/gen-items.py` reads it (if present) to regenerate `server/data/{items,shop,prod}.json` with ids and technical fields only.

Not captured (not issued at startup): leaderboards, tournaments, tutorial step ids (account had none), friends/guild data.
