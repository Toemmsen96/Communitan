// Server list model, mirrors the mod's Communitan.servers.json (Communitan/ServerList.cs) so lists import/export 1:1:
//   {selected:"<name>|Official", servers:[{Name,Host,Port,Scheme,ServerKey,StatusKey?}], acknowledged:["host:port"]}
// Stored in storage.local under "communitan". Used by the popup (ES module); bridge.js reads the same key.

export const api = globalThis.browser ?? globalThis.chrome;
export const OFFICIAL = "Official";
export const DEFAULT_KEY = "defaultkey";
export const DEFAULT_STATUS_KEY = "catan-public-status";
const STORE = "communitan";

export function emptyModel() {
  return { selected: OFFICIAL, servers: [], acknowledged: [] };
}

export async function load() {
  const got = await api.storage.local.get(STORE);
  return normalize(got[STORE]);
}

export async function save(model) {
  await api.storage.local.set({ [STORE]: normalize(model) });
}

// Accepts the mod's file as well as partial/foreign input; drops invalid entries.
export function normalize(raw) {
  const m = emptyModel();
  if (!raw || typeof raw !== "object") return m;
  for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
    if (!s || typeof s.Name !== "string" || !s.Name.trim() || typeof s.Host !== "string" || !s.Host) continue;
    if (s.Name === OFFICIAL || m.servers.some((x) => x.Name === s.Name)) continue;
    const e = {
      Name: s.Name.trim(),
      Host: s.Host,
      Port: Number.isInteger(s.Port) && s.Port > 0 && s.Port < 65536 ? s.Port : 7350,
      Scheme: s.Scheme === "https" ? "https" : "http",
      ServerKey: typeof s.ServerKey === "string" && s.ServerKey ? s.ServerKey : DEFAULT_KEY,
    };
    if (typeof s.StatusKey === "string" && s.StatusKey) e.StatusKey = s.StatusKey;
    m.servers.push(e);
  }
  m.selected = m.servers.some((s) => s.Name === raw.selected) ? raw.selected : OFFICIAL;
  m.acknowledged = Array.isArray(raw.acknowledged) ? raw.acknowledged.filter((a) => typeof a === "string") : [];
  return m;
}

export const hostPort = (e) => `${e.Host}:${e.Port}`.toLowerCase();
export const url = (e) => `${e.Scheme}://${e.Host}:${e.Port}`;
export const address = (e) => (e.Scheme === "http" ? `${e.Host}:${e.Port}` : url(e));
export const statusKey = (e) => e.StatusKey || DEFAULT_STATUS_KEY;

export function isLoopback(host) {
  host = (host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

// http to anything but this machine: passwords etc. travel in plain text.
export const unencrypted = (e) => e.Scheme !== "https" && !isLoopback(e.Host);

// "host", "host:port" or "http(s)://host[:port]"; default scheme http, port 7350 (ServerEntry.TryParseAddress).
export function parseAddress(text) {
  let scheme = "http";
  let port = 7350;
  let rest = (text || "").trim().replace(/\/+$/, "");
  const sep = rest.indexOf("://");
  if (sep >= 0) {
    scheme = rest.slice(0, sep).toLowerCase();
    rest = rest.slice(sep + 3);
    if (scheme !== "http" && scheme !== "https") return { error: "Scheme must be http or https" };
  }
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    port = Number(rest.slice(colon + 1));
    if (!/^\d+$/.test(rest.slice(colon + 1)) || port < 1 || port > 65535) return { error: "Port must be 1-65535" };
    rest = rest.slice(0, colon);
  }
  if (!rest || /[ /:?#@]/.test(rest)) return { error: "Enter host, host:port or http(s)://host:port" };
  return { scheme, host: rest, port };
}

// GET /healthcheck, then the public COMMUNITAN_STATUS RPC (docs/protocol/core.md 5.4). Nakama answers CORS for any origin.
export async function ping(entry) {
  const base = url(entry);
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/healthcheck`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  const ms = Math.round(performance.now() - t0);
  let status = null;
  try {
    const r = await fetch(`${base}/v2/rpc/COMMUNITAN_STATUS?http_key=${encodeURIComponent(statusKey(entry))}&unwrap`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) status = await r.json();
  } catch {}
  return { ok: true, ms, status };
}

// "5 online · 2 playing · 1 searching · server dice · rules enforced · free tier" (ServerPing.cs).
export function describeStatus(s) {
  if (!s || typeof s !== "object") return "";
  const parts = [`${s.online ?? 0} online`, `${s.playing ?? 0} playing`, `${s.searching ?? 0} searching`];
  if (s.rng === "seeds") parts.push("server seeds");
  if (s.rng === "full") parts.push("server dice");
  if (s.rules === "audit") parts.push("rules audited");
  if (s.rules === "enforce") parts.push("rules enforced");
  if (s.entitlements === "free") parts.push("free tier");
  if (s.entitlements === "owned") parts.push("own purchases");
  return parts.join(" · ");
}
