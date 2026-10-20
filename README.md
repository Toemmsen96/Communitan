# Communitan

**Community servers for Catan Universe.** The name is *Community* + *Catan*.

Play **Catan Universe** on self-hosted servers: a BepInEx mod for the game plus a reimplementation of its online backend on [Nakama](https://heroiclabs.com/nakama/).

> **Disclaimer:** This is an unofficial, non-commercial personal fan project. It is **not affiliated with, endorsed by, or supported by United Soft Media (USM), CATAN GmbH, or the developers/publishers of Catan Universe**. "Catan" and "Catan Universe" are trademarks of their respective owners. No game files or game texts are distributed here; you need your own copy of the game. Use at your own risk; provided as is, without warranty.

> **Status:** work in progress. See [PLAN.md](PLAN.md) for what works.

## Privacy & security — read before joining a custom server
Custom servers are **community hosted**. They are run by whoever set them up, not by USM, CATAN GmbH or the authors of this project. Nobody vets them, and the mod cannot tell a trustworthy server from a malicious one.

**Never use your official Catan Universe login on a custom server.** Create a separate account for every community server, with a password you use nowhere else, or play as a guest. The game sends your email and password to whichever server is selected. A server operator, or anyone who can read unencrypted traffic, can see them and could use them to take over your official account or any other account where you reused that password.

What a server you connect to receives and can store:
| Data | When |
|---|---|
| Email address and **password** | Email login and registration. The password arrives in plain text and is only hashed after it reaches the server; a modified server can log it. |
| Device identifier, OS, platform, language, game version | Every login; guest accounts are tied to the device identifier. On custom servers the mod sends a **per-server id** (`sha256(real id + "|" + host:port)`, 40 hex chars) instead of Unity's hardware-derived one, so two servers can't match you up by it. |
| Steam ID | **Not sent to custom servers**: the mod removes `STEAM_ID`/`steamId` from every request (the game would send it with shop/price requests). Official servers still get it as usual. |
| IP address | Every connection. |
| Your official purchases: owned expansions (bitmask) and owned item ids, plus `sha256` of your official user id and the time they were recorded | **Only** to servers whose public status says `owned` (shown as "own purchases" in the server list), right after you log in there. Nothing else from your official account is sent: no login, token, email, gold, progress or ratings. The mod records this locally (`BepInEx/config/Communitan.entitlements.json`) whenever you log in to the official servers; deleting it stops the mirroring until your next official login. |
| Display name, avatar, friends, blocks, guild membership, chat and whisper messages, mail, match history, ratings | While you play. |

- **Encryption:** `http://` servers (the default for self-hosted ones) send everything **unencrypted**, including passwords. Only `https://` servers, for example behind a reverse proxy with a valid certificate, encrypt traffic. `127.0.0.1` / `localhost` never leaves your machine.
- **Data retention and deletion** are entirely up to the server operator. There is no guarantee your data is protected, backed up, kept, or deleted on request. Accounts, progress and items on a community server can disappear at any time.
- **Nothing carries over.** Official and custom accounts are completely separate, and so is every custom server from every other. Progress, level and XP, items and unlocks, gold and tickets, ratings (ELO), leaderboard and season placements, achievements, friends, guilds, mail and match history stay on the server where you earned them and are **not** transferred to the official servers or other custom servers, in either direction. Rankings on a community server are not official rankings. Nothing you do on a custom server affects your official account. Custom servers sell nothing; by default (`free`) a server gives you what a free official account has. The one exception: a server in `owned` mode also unlocks the expansions and items **you bought** on the official servers (mirrored by the mod, see the table above). Progress, gold, tickets and ratings are never mirrored.
- **Analytics:** with `Privacy.BlockAnalytics = true` (default) and a custom server selected, the mod drops the game's GameAnalytics events (gameanalytics.com) and points its endpoints nowhere, switches off Unity Analytics / performance reporting, and skips Unity Gaming Services init (only if the custom server was selected before the shop initialised it). Official servers are never affected.
- **Guest accounts and the per-server id:** servers that were already in your server list before this version keep the real device id (`"LegacyDeviceId": true` in `Communitan.servers.json`) so an existing guest account there stays reachable; servers added later get the per-server id. Set or remove that flag by hand if you need to; changing it means a new guest account on that server (a stored login keeps working until it expires).
- **In game:** before you first join a custom server the mod shows a one-time "Community server" warning (acknowledged per host:port in the server list), marks `http://` servers that aren't on your own machine as **NOT ENCRYPTED**, and shows "Community server — do not use your official password." on the login and register screens.
- **Server list status:** for custom servers the server list (and the matchmaking screen) asks the server for its public player counts (`GET /v2/rpc/COMMUNITAN_STATUS?http_key=...`, no login, no account data sent). Like the ping, the server sees your IP address. Official servers are only pinged.
- **Local logs:** with `Debug.TrafficLog` enabled (off by default; the dev scripts turn it on), the mod writes all server traffic to `BepInEx/traffic.jsonl` on your PC, with passwords masked. It contains your ids and messages; don't share it publicly without redacting it.
- **Using mods** may violate the game's terms of service. You use this project at your own risk.

**If you run a server for other people**, you are responsible for it, including any data-protection obligations (e.g. GDPR) that apply where you and your players live. At a minimum: generate your own secrets (`tools/server-init.sh` writes `.env`), change the server key, put the server behind HTTPS, keep the console (port 7351) and the database private, keep backups, and tell your players what you store and how to get it deleted.

## Operator responsibility and liability
Running a server is your own decision and **your own legal responsibility**. The software is provided as is, without warranty (see [LICENSE](LICENSE)).

- **Paid content stays paid.** Expansions, cosmetics and currency are sold by USM on official accounts. By default a server grants only what a free official account has (`CATAN_ENTITLEMENTS=free`); `owned` mirrors each player's own official purchases. Changing, patching or bypassing these checks to hand out paid content, for example by using development unlock settings on a public server or editing the server code, is entirely on you.
- **You alone are liable** for how you run, configure or modify your server: unlocking paid content, breaking the game's or USM's terms, infringing anyone's rights, and handling your players' data. The authors and contributors of this project accept no liability for operators' servers or for what operators or players do with them.
- Using mods and community servers may violate the game's terms of service, for operators and players alike.

## Install the mod
Download `Communitan-<version>-with-BepInEx.zip` from the releases page and unzip it into the game folder (next to `CatanUniverse.exe`); or, if BepInEx 5 is already installed, use `Communitan-<version>.zip` (just the plugin). On Linux/Proton set the Steam launch options to `WINEDLLOVERRIDES="winhttp=n,b" %command%`. Start the game and choose a server (**Server: ...** button on the login screen, or F10). Details: `INSTALL.txt` in the zip. BepInEx: [BepInEx 5 **x86**](https://github.com/BepInEx/BepInEx/releases) (MIT).

## Host a server
Needs only Podman or Docker (with compose). Download `communitan-server-<version>.zip`, then:
```sh
tools/server-init.sh     # generates random secrets into .env
podman-compose up -d     # or: docker compose up -d
```
Players connect to `http://<your-ip>:7350` (only that port is public; console and gRPC are localhost-only). The server publishes anonymous player counts (online / playing / searching per mode) to anyone via the public status key `NAKAMA_HTTP_KEY` (default `catan-public-status`); that key reaches nothing else. Paid content: `CATAN_ENTITLEMENTS=free` (default) or `owned`, see [docs/HOSTING.md](docs/HOSTING.md#entitlements-paid-content) and the liability section above. See [docs/HOSTING.md](docs/HOSTING.md) for the security checklist, HTTPS (Caddy / Let's Encrypt), firewall, backups, updating and GDPR notes. Without `.env` the server runs with insecure public dev defaults and logs a warning. The server ships no game content; item names are derived from their ids, and the in-game almanac can optionally be served from your own game install with `tools/gen-almanac.py` (see [docs/HOSTING.md](docs/HOSTING.md#game-content-almanac-item-names)).

The server sends no email. New email accounts confirm a 5-digit code that the game shows in-game (`CATAN_EMAIL_VERIFICATION=ingame`, the default) or skip that step (`off`, set in `.env`). The in-game "forgot password" flow does not work: the operator resets passwords in the Nakama console (see [docs/HOSTING.md](docs/HOSTING.md#accounts-email-verification-and-password-reset)).

## How it works
- **Mod** (`Communitan/`): on startup you pick *Official servers* or one of your *custom servers*, in a server list like Minecraft's (add a server by name + IP). The mod points the game's Nakama client at the chosen server. The screen is built from the game's own popups; reopen it with the **Server: ...** button on the login screen (or F10). Switching logs you out of the old server.
- **Server** (`server/`): Nakama + Postgres (containers) with a TypeScript runtime module that implements the game's backend: accounts, profile/avatar (free-tier content, or the player's own official purchases on `owned` servers), friends, guilds, mail, chat, matchmaking, custom lobbies and online games.
- **Fair dice (optional):** a server can roll the dice and decide steals and card draws itself (`CATAN_SERVER_RNG=full`, server list label "server dice"; needs the current mod on every player's PC). The game itself has every client simulate the whole match, so a modified client could otherwise predict or choose rolls; it still sees all game state. See [docs/HOSTING.md](docs/HOSTING.md).

## Development
Play against AI opponents on your own server: start the game from Steam, then `tools/bots.sh start` (Linux; see [tools/README.md](tools/README.md#bots-play-against-ai-opponents-on-a-custom-server)).

Build from source: `server/` is `npm ci && npm run build` then `podman-compose up -d` (dev defaults without `.env`); `tools/release.sh <version>` builds the zips into `dist/` (needs the game for the mod). CI (`.github/workflows/server.yml`) covers the server only. See [CLAUDE.md](CLAUDE.md) (layout, commands), [tools/README.md](tools/README.md) (build, headless runs) and [docs/protocol/](docs/protocol/) (reverse-engineered protocol specs).

## License
See [LICENSE](LICENSE). This covers only the code in this repository, not the game or its assets.
