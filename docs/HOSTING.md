# Hosting a Catan custom server

You need Docker or Podman (with compose) and a machine reachable by your players. No Node.js needed when using the release zip (`communitan-server-<v>.zip`); from the repo run `cd server && npm ci && npx tsc` first.

## Operator responsibility and liability
Running a server is your own decision and **your own legal responsibility**. The software is provided as is, without warranty (see [LICENSE](../LICENSE)).

- **Paid content stays paid.** Expansions, cosmetics and currency are sold by USM on official accounts. By default a server grants only what a free official account has (`CATAN_ENTITLEMENTS=free`); `owned` mirrors each player's own official purchases. Changing, patching or bypassing these checks to hand out paid content, for example by using development unlock settings on a public server or editing the server code, is entirely on you.
- **You alone are liable** for how you run, configure or modify your server: unlocking paid content, breaking the game's or USM's terms, infringing anyone's rights, and handling your players' data. The authors and contributors of this project accept no liability for operators' servers or for what operators or players do with them.
- Using mods and community servers may violate the game's terms of service, for operators and players alike.

## Quick start
```sh
unzip communitan-server-<v>.zip && cd communitan-server-<v>
tools/server-init.sh          # writes .env with random secrets (never overwrites an existing one)
podman-compose up -d          # or: docker compose up -d
```
Players add `http://<your-ip>:7350` (or `https://domain:443`, see below) in the mod's server list. Open TCP 7350 only.

## Security checklist
- [ ] `.env` exists (run `server-init.sh`). Without it the **public dev defaults** are used and the log prints a loud warning: anyone could forge sessions and log into the console.
- [ ] `.env` is private (mode 600) and never committed or shared. Changing secrets logs all players out; that is fine.
- [ ] Only 7350 is public. Console (7351) and gRPC (7349) are bound to 127.0.0.1; use an SSH tunnel (`ssh -L 7351:127.0.0.1:7351 host`). Postgres is not published at all.
- [ ] HTTPS enabled (below). Plain `http://` sends players' passwords unencrypted.
- [ ] `NAKAMA_SERVER_KEY`: the client key is **not a secret**; the mod sends it with every request and players type it in (Advanced). It only keeps random clients out. Still change it per server (default `defaultkey`) and give it to your players.
- [ ] `NAKAMA_HTTP_KEY` (Nakama `runtime.http_key`) is a **public status key**, default `catan-public-status`, and not a secret either. Anyone can call `GET /v2/rpc/COMMUNITAN_STATUS?http_key=<key>&unwrap` and gets only counts and modes: `{online, playing, searching, modes:{<mode>:{searching, playing}}, rng, entitlements, name?, motd?}`. Every other RPC refuses calls without a player session, so the key reaches nothing else. The mod uses the default to show counts in the server list; if you change it, players see only the ping (they can set `"StatusKey"` on the server entry in `Communitan.servers.json`). Optional `serverName` / `motd` in `data/news.json` are returned as `name` / `motd`. Older `.env` files have a random `RUNTIME_HTTP_KEY`: it is no longer used and can be deleted.
- [ ] Firewall: allow 7350/tcp (or 80+443/tcp with HTTPS), deny everything else. With HTTPS set `NAKAMA_BIND=127.0.0.1` in `.env` so 7350 is not public.
- [ ] Backups (below) and a plan to update.
- [ ] Tell players what you store, how long, and how to get it deleted (the game has a delete-account function), and how to reach you for a password reset (see below).

## HTTPS (Caddy, automatic Let's Encrypt)
DNS `A`/`AAAA` record for your domain pointing at the host, ports 80 and 443 open. In `.env`:
```
DOMAIN=catan.example.org
NAKAMA_BIND=127.0.0.1
```
then `docker compose --profile https up -d` (podman: `podman-compose --profile https up -d`). Players add the server as `https://catan.example.org:443`. WebSockets work through Caddy unchanged.

## Accounts: email verification and password reset
The server never sends email (no SMTP support yet).
- **Email verification**, `CATAN_EMAIL_VERIFICATION` in `.env` (then `docker compose up -d`):
  - `ingame` (default): a new email account must enter a 5-digit activation code. The game shows the code to the logged-in player (the mod displays it on the activation screen). Only that player can ask for it. Guest/device accounts and accounts created before this setting existed never need it.
  - `off`: new email accounts are verified immediately.
  - To verify a player by hand: console, Storage, delete the object `email_verify` / `pending` of that user.
- **Password reset needs you.** The game's "forgot password" flow cannot work without mail. It never hands out reset codes in-game, because anyone who knows an email address could then take over that account. To reset a password, check that the request really comes from the owner, then use the Nakama console (Accounts, the player, Authentication, set a new password), or call `POST /v2/console/account/<user id>` with `{"password":"<new>"}` and a console token, or run `tools/reset-password.sh <email> <new-password>`. Tell your players how to reach you.

## Server-side randomness (anti-cheat)
`CATAN_SERVER_RNG` in `.env` (then `docker compose up -d`). The mod's server list shows "server seeds" or "server dice".
- `off` (default): the creator's client picks the board, dice and color seeds, as in the original game.
- `seeds`: the server picks them for every new online game. A modified game client can no longer choose a seed it likes (a known board or dice sequence). This does **not** stop a modified client from faking a roll or seeing upcoming rolls.
- `full`: `seeds`, plus the server rolls every die (also the C&K event die and the Alchemist's event die) and hands out a fresh random value with every move, which decides robber steals, development cards, progress cards and Seafarers treasures/fog tiles at the moment they happen. No client can predict or choose them. **Every player needs a current mod**: clients without it get "update the Communitan mod" and cannot start or join games (they would go out of sync). Games started before switching keep their old mode.
- Limits of `full`: every game client still holds the whole game state (a modified client can see other hands and the remaining cards), and other move details are not checked by the server. See [design/server-rng.md](design/server-rng.md).

## Entitlements (paid content)
`CATAN_ENTITLEMENTS` in `.env` (then `docker compose up -d`). Read the [liability section](#operator-responsibility-and-liability) first. The mod's server list shows "free tier" or "own purchases". Nothing is ever sold: the shop shows everything as not purchasable, there are no real-money products and gold/tickets cannot buy anything.
- `free` (default): every player gets what a **free official account** has: no expansions (bitmask 0), the official starter avatar items and colors, level rewards for their level, 0 gold and tickets. Like on the official servers a free account can play the base game **online in "Free Play"** (free match), the tutorials, and **AI games via the sun** (1 sun, reloads 24 h after use; the official reload time is unknown). Auto (ranked) match, the full custom-lobby options (free accounts get 3 players and easy AI there), seasons and the expansions need the purchase.
- `owned`: `free` plus each player's **own official purchases**. The mod records them when the player logs in to the official servers (expansions bitmask, owned item ids, `sha256` of the official user id; no login data) and sends them to `owned` servers only, right after login (`COMMUNITAN_ENTITLEMENTS_CLAIM`). The server keeps known item ids (unknown ones are dropped), expansion bits of known expansions only, and never mirrors gold, tickets, level or ratings.
  - Soft anti-sharing: each official account (its hash) unlocks only the **first** account on this server that claims it; later claims for the same hash from another account are refused (deleting that account frees it again). Storage: `ent_bind/<hash>` (system user) and `entitlements/claim` per player, both server-only.
  - **Not tamper-proof.** The claim comes from the player's PC. A modified client can claim purchases it does not have; the server cannot verify them against USM. `owned` only makes honest mirroring easy, it does not prove ownership.
- Entitlements are computed when they are read, so switching the mode applies to existing accounts immediately. Accounts created by older versions of this server (everything unlocked, 99999 gold) are reset once to the defaults above.

## Game content (almanac, item names)
The repository and the server zip contain **no game content**: no almanac, no item/shop names or descriptions, no terms. The catalogs in `data/` hold only ids and technical fields; the server shows item and product names derived from their ids (e.g. "Board Piece Viking"). Names you add yourself to the data files (`Name`/`Description`, or `itemDef.displayName`/`description`) are shown instead.
- **Almanac (optional):** without `data/almanac.json` players keep the almanac their game already has (the bundled English one, or the one in their language from the official servers). To serve it from the server anyway, generate it from **your own** game install: `python3 tools/gen-almanac.py "<game>/CatanUniverse_Data"` (writes `data/almanac.json`), then `docker compose restart nakama`. It is English and is sent only to English clients; others keep theirs. Do not publish the generated file: it is USM's text.

## Backups
```sh
docker compose exec -T postgres pg_dump -U postgres nakama | gzip > backup-$(date +%F).sql.gz
# restore into an empty database:
gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U postgres nakama
```
Back up `.env` too (without it nothing can be decrypted/logged in the same way) and keep copies off the machine. Data lives in the `pgdata` volume.

## Updating
Unzip the new release over the old directory (keep `.env`), then `docker compose pull && docker compose up -d`. Migrations run on start. Back up first.

## Privacy / GDPR note
The public status endpoint exposes only aggregate counts (no names or ids). You are the data controller for whatever players give your server: emails, password hashes, IPs (in logs), device ids, display names, chat, mail, match history. If you host for people in the EU/UK (or elsewhere with similar law) you need a legal basis, a short privacy notice, a way to export/delete a user's data on request, and sensible retention (rotate logs, delete old backups). This is general information, not legal advice. Your players are also warned in the mod never to reuse official credentials, but you must not log or misuse passwords either.
