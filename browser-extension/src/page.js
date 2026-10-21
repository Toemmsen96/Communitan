// MAIN-world content script (document_start, top frame; the game has no iframe): points the web game's Nakama traffic at the selected
// community server. Browser counterpart of the mod's NakamaConfig redirect + device id salting (Patches.cs, Privacy.cs).
// - Requests/sockets to the official hosts (catan-{prod,qa,dev}N.*.nakamacloud.io) are rewritten to the target URL.
// - Basic auth (server key, only on /v2/account/authenticate/* and session refresh) is replaced with the target's key.
// - Guest device ids become sha256(id + "|" + host:port)[0:40], same as the mod, so servers can't correlate players.
// - Official selected (or no answer from bridge.js within CONFIG_WAIT_MS): everything passes through untouched.
// The target is pinned at the first redirected request; switching servers needs a page reload.
(() => {
  if (window.__communitan) return;
  window.__communitan = true;

  const OFFICIAL_HOST = /^catan-(prod|qa|dev)\d*\.[a-z0-9-]+\.nakamacloud\.io$/i;
  const CONFIG_WAIT_MS = 5000;

  const nativeFetch = window.fetch;
  let config = null; // {active, name, url, hostPort, serverKey}
  let pinned = false;
  let warmed = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  setTimeout(() => resolveReady(), CONFIG_WAIT_MS);

  const log = (msg) => document.dispatchEvent(new CustomEvent("communitan:log", { detail: msg }));

  document.addEventListener("communitan:config", (e) => {
    if (pinned) return;
    try {
      config = JSON.parse(e.detail);
    } catch {
      return;
    }
    // Firefox (and Chrome) hold the first request to a local/LAN server behind a "local network access" prompt; the game
    // times out after 30 s waiting. Touch the server now so the prompt shows while the game is still downloading.
    if (config.active && !warmed) {
      warmed = true;
      nativeFetch.call(window, config.url + "/healthcheck", { mode: "no-cors" }).catch(() => {});
    }
    resolveReady();
  });
  document.dispatchEvent(new CustomEvent("communitan:hello"));

  function parse(u) {
    try {
      return new URL(u, location.href);
    } catch {
      return null;
    }
  }

  const isOfficial = (u) => u && OFFICIAL_HOST.test(u.hostname);
  const active = () => config && config.active;

  // Official URL -> same path/query on the target (ws/wss follows the target's http/https).
  function retarget(u) {
    if (!pinned) {
      pinned = true;
      log(`redirecting ${u.host} -> ${config.url} (${config.name})`);
    }
    const t = new URL(config.url);
    const out = new URL(u.href);
    out.protocol = u.protocol.startsWith("ws") ? (t.protocol === "https:" ? "wss:" : "ws:") : t.protocol;
    out.hostname = t.hostname;
    out.port = t.port;
    return out.href;
  }

  const basicAuth = () => "Basic " + btoa(config.serverKey + ":");
  const fixAuth = (value) => (/^basic /i.test(value) ? basicAuth() : value);

  async function salt(id) {
    const data = new TextEncoder().encode(id + "|" + config.hostPort);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }

  // POST /v2/account/authenticate/device {"id": ...} -> salted id; other bodies unchanged.
  async function fixBody(u, body) {
    if (typeof body !== "string" || !u.pathname.endsWith("/v2/account/authenticate/device")) return body;
    try {
      const json = JSON.parse(body);
      if (typeof json.id !== "string" || !json.id) return body;
      json.id = await salt(json.id);
      return JSON.stringify(json);
    } catch {
      return body;
    }
  }

  // --- fetch
  window.fetch = function (input, init) {
    const u = parse(input instanceof Request ? input.url : input);
    if (!isOfficial(u)) return nativeFetch.apply(this, arguments);
    return (async () => {
      await ready;
      if (!active()) return nativeFetch.call(window, input, init);
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      if (headers.has("authorization")) headers.set("authorization", fixAuth(headers.get("authorization")));
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? await fixBody(u, await req.text()) : undefined;
      return nativeFetch.call(window, retarget(u), {
        method: req.method,
        headers,
        body,
        credentials: req.credentials,
        cache: req.cache,
        redirect: req.redirect,
        signal: req.signal,
      });
    })();
  };

  // --- XMLHttpRequest
  // Normal case: config is known at open() -> rewrite synchronously. Config still pending (very early request):
  // open/headers are recorded and replayed at send() once it arrives.
  const XHR = XMLHttpRequest.prototype;
  const nativeOpen = XHR.open;
  const nativeSetHeader = XHR.setRequestHeader;
  const nativeSend = XHR.send;
  const state = new WeakMap(); // xhr -> {u, deferred?: {args, headers}}

  XHR.open = function (method, url, ...rest) {
    const u = parse(url);
    if (!isOfficial(u)) {
      state.delete(this);
      return nativeOpen.call(this, method, url, ...rest);
    }
    if (config) {
      state.set(this, { u, live: active() });
      return nativeOpen.call(this, method, active() ? retarget(u) : url, ...rest);
    }
    state.set(this, { u, deferred: { args: [method, url, ...rest], headers: [] } });
  };

  XHR.setRequestHeader = function (name, value) {
    const s = state.get(this);
    if (s?.deferred) return void s.deferred.headers.push([name, value]);
    if (s?.live && name.toLowerCase() === "authorization") value = fixAuth(value);
    return nativeSetHeader.call(this, name, value);
  };

  XHR.send = function (body) {
    const s = state.get(this);
    if (!s || (!s.deferred && !s.live)) return nativeSend.call(this, body);
    (async () => {
      if (s.deferred) {
        await ready;
        const [method, url, ...rest] = s.deferred.args;
        s.live = active();
        nativeOpen.call(this, method, s.live ? retarget(s.u) : url, ...rest);
        for (const [n, v] of s.deferred.headers)
          nativeSetHeader.call(this, n, s.live && n.toLowerCase() === "authorization" ? fixAuth(v) : v);
        delete s.deferred;
      }
      nativeSend.call(this, s.live ? await fixBody(s.u, body) : body);
    })();
  };

  // --- WebSocket (the game connects long after load, so config is always known by then)
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const u = parse(args[0]);
      if (isOfficial(u) && active()) args = [retarget(u), ...args.slice(1)];
      else if (isOfficial(u) && !config) log("socket opened before config arrived; left on official server");
      return Reflect.construct(target, args, newTarget);
    },
  });
})();
