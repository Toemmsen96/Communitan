// Server randomness (anti-cheat), env CATAN_SERVER_RNG=off|seeds|full. Design + findings: docs/design/server-rng.md
// off: the creator's seeds are kept. seeds: server CSPRNG seeds (mp_match.ts). full = seeds plus, per accepted action:
//   - dice: Base_RollDice/Cak_RollDice blobs get server dice written into asBaseRollDice.diceValues (stored/relayed/acked)
//   - word: a fresh 64-bit random word per action UniqueId (ack, GAME_ACTION_PLAYED push, GAMESTATE_AND_ACTIONS_V3);
//     the mod mixes it into the game's replicated RNG state when the action is applied (CommonGameState.Apply), so
//     every later local draw (robber steal, dev card pick, C&K/Seafarers draws) is unknown until that action is accepted.
// Only clients that send communitanCaps (the mod, when all its RNG patches are active) may play on a "full" server.
// Nakama's uuidv4 comes from Go crypto/rand: all randomness below is taken from its random hex digits.

const RNG_CAPS = "rng-full-1";
const RNG_ERR_CAPS = 110; // UnableToUpdateMultiplayerProgress: shown as a popup with customErrorMessage
const RNG_CAPS_MSG = "This server rolls the dice itself (server dice). Update the Communitan mod to play here.";
const RNG_ROLL_IDS: { [catanActionId: number]: number } = { 3: 2, 151: 3 }; // Base_RollDice: 2 dice, Cak_RollDice: 2 + event die
const RNG_ALCHEMIST = 210; // Cak_PlayProgressCard_Alchemist: player picks both production dice, the event die is rolled

function rngMode(ctx: nkruntime.Context): string {
    const m = String((ctx.env && ctx.env["CATAN_SERVER_RNG"]) || "off").trim().toLowerCase();
    return m === "seeds" || m === "full" ? m : "off";
}

function rngHasCaps(c: GsContext): boolean {
    return String(c.req.communitanCaps || "").split(",").indexOf(RNG_CAPS) >= 0;
}

// Throws the "update your mod" error for requests of clients without the capability (only on "full" servers).
function rngRequireCaps(c: GsContext) {
    if (rngMode(c.ctx) === "full" && !rngHasCaps(c)) gsFail({ errorCode: RNG_ERR_CAPS, customErrorMessage: RNG_CAPS_MSG });
}

// ---- randomness from nk.uuidv4 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx: groups 1, 2 and 5 are fully random) ----
function rngHex16(nk: nkruntime.Nakama): string {
    const u = nk.uuidv4();
    return u.substring(0, 8) + u.substring(9, 13) + u.substring(24, 28);
}

class RngBytes {
    private buf: number[] = [];
    constructor(private nk: nkruntime.Nakama) {}
    byte(): number {
        if (!this.buf.length) {
            const u = this.nk.uuidv4();
            const h = u.substring(0, 8) + u.substring(9, 13) + u.substring(24, 36);
            for (let i = 0; i < h.length; i += 2) this.buf.push(parseInt(h.substring(i, i + 2), 16));
        }
        return this.buf.shift()!;
    }
    // uniform 0..n-1 (n <= 256) by rejection sampling
    below(n: number): number {
        const lim = 256 - (256 % n);
        for (;;) {
            const b = this.byte();
            if (b < lim) return b % n;
        }
    }
}

// ---- base64 (own implementation: no Buffer/ArrayBuffer API assumptions) ----
const RNG_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function rngB64Dec(s: string): number[] | null {
    const out: number[] = [];
    let acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (ch === "=") break;
        const v = RNG_B64.indexOf(ch);
        if (v < 0) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return out;
}
function rngB64Enc(b: number[]): string {
    let s = "";
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
        s += RNG_B64.charAt((n >> 18) & 63) + RNG_B64.charAt((n >> 12) & 63);
        s += i + 1 < b.length ? RNG_B64.charAt((n >> 6) & 63) : "=";
        s += i + 2 < b.length ? RNG_B64.charAt(n & 63) : "=";
    }
    return s;
}

// ---- Thrift TBinaryProtocol walker for CommonGameActionState (Common.GameLogic.Model/CommonGameActionState.cs) ----
// 1 commonActionId{1 catanActionId:i32}, 2 playerId:i32, 3 uniqueId:i32,
// 10 catanGameActionState{1000 asBaseRollDice{1 diceValues:list<i32>}, 3008 asSelectDices{1 white, 2 red, 3 eventDice:i32}}
interface RngAction { uid: number; actionId: number; playerId: number; payload: number[]; dice: number[]; /* byte offsets of the i32 dice */ event: number }

function rngI32(b: number[], p: number): number {
    if (p + 4 > b.length) throw new Error("eof");
    return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
}

// end position of a value of thrift type t starting at p
function rngSkip(b: number[], p: number, t: number, depth: number): number {
    if (depth > 64) throw new Error("depth");
    switch (t) {
        case 2: case 3: return p + 1;
        case 6: return p + 2;
        case 8: return p + 4;
        case 4: case 10: return p + 8;
        case 11: { const n = rngI32(b, p); if (n < 0) throw new Error("len"); return p + 4 + n; }
        case 12: return rngFields(b, p, depth + 1, () => -1);
        case 13: {
            const kt = b[p], vt = b[p + 1], n = rngI32(b, p + 2);
            let q = p + 6;
            for (let i = 0; i < n; i++) { q = rngSkip(b, q, kt, depth + 1); q = rngSkip(b, q, vt, depth + 1); }
            return q;
        }
        case 14: case 15: {
            const et = b[p], n = rngI32(b, p + 1);
            let q = p + 5;
            for (let i = 0; i < n; i++) q = rngSkip(b, q, et, depth + 1);
            return q;
        }
    }
    throw new Error("type " + t);
}

// Walks the fields of a struct at p; visit(id, type, pos) returns the field's end or -1 (= skip generically). Returns the end.
function rngFields(b: number[], p: number, depth: number, visit: (id: number, t: number, pos: number) => number): number {
    for (;;) {
        if (p >= b.length) throw new Error("eof");
        const t = b[p++];
        if (t === 0) return p;
        const id = ((b[p] << 8) | b[p + 1]) << 16 >> 16;
        p += 2;
        const end = visit(id, t, p);
        p = end >= 0 ? end : rngSkip(b, p, t, depth);
        if (p > b.length) throw new Error("eof");
    }
}

function rngParse(b: number[]): RngAction | null {
    const a: RngAction = { uid: -1, actionId: -1, playerId: -1, payload: [], dice: [], event: -1 };
    try {
        const end = rngFields(b, 0, 0, (id, t, p) => {
            if (id === 1 && t === 12) return rngFields(b, p, 1, (i2, t2, p2) => { if (i2 === 1 && t2 === 8) a.actionId = rngI32(b, p2); return -1; });
            if (id === 2 && t === 8) a.playerId = rngI32(b, p);
            if (id === 3 && t === 8) a.uid = rngI32(b, p);
            if (id === 10 && t === 12) {
                const e = rngFields(b, p, 1, (i2, t2, p2) => {
                    if (i2 === 3008 && t2 === 12) return rngFields(b, p2, 2, (i3, t3, p3) => { if (i3 === 3 && t3 === 8) a.event = p3; return -1; });
                    if (i2 !== 1000 || t2 !== 12) return -1;
                    return rngFields(b, p2, 2, (i3, t3, p3) => {
                        if (i3 !== 1 || t3 !== 15 || b[p3] !== 8) return -1;
                        const n = rngI32(b, p3 + 1);
                        for (let i = 0; i < n && i < 8; i++) a.dice.push(p3 + 5 + 4 * i);
                        return -1;
                    });
                });
                a.payload = b.slice(p, e);
                return e;
            }
            return -1;
        });
        if (end !== b.length || a.uid < 0) return null;
    } catch (e) {
        return null;
    }
    return a;
}

// ---- per-action processing (called from mpAction inside the session mutation) ----
interface RngRec { u: number; h: string; w: string; d?: number[] }

function rngPublic(r: RngRec | null | undefined): any {
    if (!r) return null;
    const o: any = { u: r.u, w: r.w };
    if (r.d) o.d = r.d;
    return o;
}

// Dice for a roll: plain d6 or, with gameInfo.diceMode (the game's "dice stack"), a per-session deck of the 36 pairs.
function rngRollDice(nk: nkruntime.Nakama, s: MpSession, n: number): number[] {
    const rb = new RngBytes(nk);
    const d: number[] = [];
    if (s.gameInfo && s.gameInfo.diceMode) {
        if (!s.rngStack || !s.rngStack.length) {
            s.rngStack = [];
            for (let i = 0; i < 36; i++) s.rngStack.push(i);
        }
        const v = s.rngStack.splice(rb.below(s.rngStack.length), 1)[0];
        d.push(Math.floor(v / 6) + 1, (v % 6) + 1);
    }
    while (d.length < n) d.push(rb.below(6) + 1);
    return d;
}

// Accepts an action blob in a "full" session. prev(idx) returns the stored record of an earlier action.
// Returns the (possibly rewritten) blob + record, or {fail}. A UniqueId is bound to its first accepted payload:
// a later blob with the same UniqueId is only accepted (same word/dice) if its payload is identical (the client
// sends some actions twice, once flagged as AI); anything else gets 111, so probing a word is never useful.
function rngAccept(nk: nkruntime.Nakama, s: MpSession, blob: string, idx: number, prev: (idx: number) => RngRec | null): { blob?: string; r?: RngRec; fail?: number } {
    const b = rngB64Dec(blob);
    const a = b ? rngParse(b) : null;
    if (!b || !a) return { fail: MP_ERR.progress };
    const h = nk.sha256Hash(a.actionId + ":" + a.playerId + ":" + rngB64Enc(a.payload)).substring(0, 16);
    s.rngU = s.rngU || {};
    const k = String(a.uid);
    let r: RngRec;
    if (s.rngU[k] !== undefined) {
        const p = prev(s.rngU[k]);
        if (!p || p.h !== h) return { fail: MP_ERR.lastAction };
        r = { u: a.uid, h: h, w: p.w };
        if (p.d) r.d = p.d;
    } else {
        r = { u: a.uid, h: h, w: rngHex16(nk) };
        const n = RNG_ROLL_IDS[a.actionId];
        if (n && a.dice.length >= n) r.d = rngRollDice(nk, s, n);
        if (a.actionId === RNG_ALCHEMIST && a.event >= 0) r.d = [new RngBytes(nk).below(6) + 1];
        s.rngU[k] = idx;
    }
    if (r.d && a.actionId === RNG_ALCHEMIST && a.event >= 0) {
        b[a.event] = 0; b[a.event + 1] = 0; b[a.event + 2] = 0; b[a.event + 3] = r.d[0];
        blob = rngB64Enc(b);
    } else if (r.d && a.dice.length >= r.d.length) {
        for (let i = 0; i < r.d.length; i++) {
            const o = a.dice[i];
            b[o] = 0; b[o + 1] = 0; b[o + 2] = 0; b[o + 3] = r.d[i];
        }
        blob = rngB64Enc(b);
    }
    return { blob: blob, r: r };
}
