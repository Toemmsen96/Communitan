# Communitan browser extension

Plays the official Catan Universe **browser game** (https://catanuniverse.com/game/) on a community server.
Chrome/Chromium/Edge (MV3) and Firefox 128+. Browser counterpart of the BepInEx mod; same server list format.

## Install (unpacked, development)
```
cd browser-extension && npm run build      # -> dist/chrome, dist/firefox + zips
```
- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`

Click the toolbar icon, add a server (`host:port` or `https://host`, server key default `defaultkey`), select it, reload the game tab.
Import/Export reads and writes the mod's `BepInEx/config/Communitan.servers.json`.

## How it works
| File | Role |
|---|---|
| `src/page.js` | MAIN world, `document_start`: wraps `fetch`, `XMLHttpRequest`, `WebSocket`. Requests to `catan-{prod,qa,dev}N.*.nakamacloud.io` go to the selected server; Basic auth (server key) swapped; guest device id salted `sha256(id\|host:port)[0:40]` like the mod. Target pinned at first redirect → switching needs a reload. Official / no config within 5 s → pass-through |
| `src/bridge.js` | isolated world: storage → page via DOM events (`communitan:hello` / `communitan:config` / `communitan:log`). Deletes a saved login made against another server (`/idbfs/<hash>/user.config` in IndexedDB `/idbfs`, before Unity mounts it); `storage.local.communitanAuthEndpoint` = endpoint it belongs to, none = Official |
| `src/background.js`, `rules/analytics.json` | DNR ruleset `analytics` (GameAnalytics, Unity Analytics/UGS; only requests from catanuniverse.com) enabled while a custom server is selected |
| `src/popup.*`, `src/servers.js` | server list, ping (`/healthcheck` + public `COMMUNITAN_STATUS`), community-server warning, import/export |

Web build facts (2026-10-21, build `77fe79715`, Unity 2022.3.62f3): game canvas on the catanuniverse.com top page (no iframe, no CSP);
Nakama HTTP via global `fetch` (UnityWebRequest), socket via `new WebSocket` (Nakama jslib); same backend and key as desktop.

## Limits / todo
- **http servers only work on localhost.** The game page is https, so browsers block plain-http requests to other hosts (mixed content).
  Use an https server (`server/` Caddy profile, docs/HOSTING.md). Todo: relay http through the extension background.
- Local/LAN servers: the browser asks once "allow access to other apps and services on this device" → **Allow**. page.js touches
  `/healthcheck` at page load so the prompt shows during the download (the game gives up after 30 s otherwise).
- Web-only server gaps: `ACCOUNT_GET_PAYMENTWALL_INFOS`, `PAYMENT_GET_PAYMENTWALL_PRODUCT_PRICE` (UNHANDLED, harmless).

## Test
- 2026-10-21, Firefox 158 headless (WebDriver BiDi): installs clean; Local → guest login, socket, RPCs, main menu, 0 requests
  to nakamacloud.io, salted device id, reload re-login; Official → untouched. Chrome and the popup UI not yet tested in a browser.
- Same day, Firefox 158: analytics blocked on Local (NS_ERROR_ABORT) and reaching their servers on Official; Local→Official reload
  deletes the Local login (login screen, no auto re-login), Local reload keeps it; ruleset survives background suspend + extension reload.
- `npm test` runs `src/page.js` in a fake page (Node `vm`) and checks the redirect, key swap, salting and pass-through.
