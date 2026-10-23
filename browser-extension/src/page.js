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

  // --- In-page notices over the game canvas (closed shadow root). The web game can't be patched like the desktop one,
  // so what the mod adds to the game's screens (LoginHints.cs, RegisterFlow.cs) is shown here instead.
  const notices = (() => {
    const CSS = `
      :host { all: initial; }
      .hint, .modal { pointer-events: auto; font: 14px/1.4 system-ui, sans-serif; color: #efe6d8; }
      .hint { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); max-width: calc(100vw - 32px);
        display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px; border-radius: 8px;
        background: rgba(38, 33, 28, .92); border: 1px solid #e0b04f; box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }
      .hint b { color: #ffd45a; }
      .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); pointer-events: auto;
        display: flex; align-items: center; justify-content: center; padding: 16px; }
      .modal { width: min(420px, 100%); padding: 18px 20px; border-radius: 10px; background: #26211c;
        border: 1px solid #3a322a; box-shadow: 0 8px 32px rgba(0, 0, 0, .5); }
      h2 { margin: 0 0 8px; font-size: 17px; }
      p { margin: 0 0 12px; color: #d8cdbd; }
      .code { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
      .code span { flex: 1; padding: 8px 12px; border-radius: 6px; background: #1d1915; border: 1px solid #3a322a;
        font: 600 26px/1.2 ui-monospace, monospace; letter-spacing: .25em; text-align: center; user-select: all; }
      .actions { display: flex; justify-content: flex-end; }
      button { font: inherit; padding: 6px 14px; border-radius: 5px; border: 1px solid #3a322a; background: #1d1915;
        color: #efe6d8; cursor: pointer; }
      button.primary { background: #e0704f; border-color: #e0704f; color: #1d1915; font-weight: 600; }
      .hint button { padding: 2px 8px; }`;
    let root = null;
    let modal = null;

    function shadow() {
      if (root) return root;
      const host = document.createElement("communitan-notices");
      host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
      root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.append(style);
      (document.body || document.documentElement).append(host);
      return root;
    }

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function button(text, cls, onClick) {
      const b = el("button", cls, text);
      b.addEventListener("click", onClick);
      return b;
    }

    let hint = null;

    // Shown from page load until dismissed or logged in: the login and register screens are where passwords get typed,
    // later it would only cover the game's bottom bar.
    function passwordHint(name) {
      try {
        hint = el("div", "hint");
        const text = el("span");
        text.append(el("b", null, `Community server “${name}”`), " — do not use your official Catan password.");
        hint.append(text, button("✕", null, loggedIn));
        shadow().append(hint);
      } catch (e) {
        log(`cannot show the password hint: ${e}`);
      }
    }

    function loggedIn() {
      hint?.remove();
      hint = null;
    }

    function show(title, text, code) {
      try {
        modal?.remove();
        const backdrop = el("div", "backdrop");
        const box = el("div", "modal");
        box.append(el("h2", null, title), el("p", null, text));
        if (code) {
          const row = el("div", "code");
          const copy = button("Copy", null, () =>
            navigator.clipboard?.writeText(code).then(() => (copy.textContent = "Copied"), () => {}),
          );
          row.append(el("span", null, code), copy);
          box.append(row);
        }
        const actions = el("div", "actions");
        actions.append(button("OK", "primary", () => backdrop.remove()));
        box.append(actions);
        backdrop.append(box);
        shadow().append(backdrop);
        modal = backdrop;
      } catch (e) {
        log(`cannot show a notice: ${e}`);
      }
    }

    // scriptData of ACCOUNT_RESEND_ACTIVATION_CODE.
    function activation(sd) {
      const code = typeof sd.code === "string" || typeof sd.code === "number" ? String(sd.code) : "";
      if (code)
        show("Activation code", "This community server sends no emails. Enter this code on the activation screen:", code);
      else if (sd.delivery === "auto")
        show("No activation needed", "This community server doesn't check activation codes: enter any 5 digits, e.g. 00000.");
      else show("No activation code", "This community server sends no emails and returned no activation code. Ask its operator.");
    }

    return { passwordHint, loggedIn, activation };
  })();

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
      notices.passwordHint(config.name);
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
      const res = await nativeFetch.call(window, retarget(u), {
        method: req.method,
        headers,
        body,
        credentials: req.credentials,
        cache: req.cache,
        redirect: req.redirect,
        signal: req.signal,
      });
      watchRpc(u, headers.get("authorization"), res);
      return res;
    })();
  };

  // --- Email activation (mod: RegisterFlow.cs). Community servers send no mail: ACCOUNT_RESEND_ACTIVATION_CODE returns
  // the code to the logged-in caller ({code, delivery:"ingame"}, or {delivery:"auto"} = any code works). The game shows
  // its activation screen when a response has scriptData.needsEmailVerification; the code is then fetched once per
  // session and shown, and again whenever the game's own "resend" runs.
  const RESEND = "ACCOUNT_RESEND_ACTIVATION_CODE";
  let codeAskedFor = null; // Authorization header (session) the code was already fetched for

  // Nakama RPC response {id, payload: GS response JSON string} -> scriptData, null on GS error / other shapes.
  function scriptData(json) {
    try {
      const gs = typeof json.payload === "string" ? JSON.parse(json.payload) : json.payload;
      return gs && typeof gs === "object" && !gs.error ? gs.scriptData || {} : null;
    } catch {
      return null;
    }
  }

  function watchRpc(u, auth, res) {
    if (res.ok && u.pathname.includes("/v2/account/authenticate/")) notices.loggedIn();
    const m = /\/v2\/rpc\/([^/]+)$/.exec(u.pathname);
    if (!m || !res.ok) return;
    const id = decodeURIComponent(m[1]);
    res
      .clone()
      .json()
      .then((json) => {
        const sd = scriptData(json);
        if (!sd) return;
        if (id === RESEND) notices.activation(sd);
        else if (sd.needsEmailVerification === true && auth && auth !== codeAskedFor) {
          codeAskedFor = auth;
          requestCode(auth);
        }
      })
      .catch(() => {});
  }

  async function requestCode(auth) {
    const req = { "@class": ".LogEventRequest", eventKey: RESEND, requestId: "communitan-" + Date.now() };
    try {
      const res = await nativeFetch.call(window, config.url + "/v2/rpc/" + RESEND, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(JSON.stringify(req)),
      });
      const sd = res.ok ? scriptData(await res.json()) : null;
      if (sd) notices.activation(sd);
      else log(`activation code request failed (HTTP ${res.status})`);
    } catch (e) {
      log(`activation code request failed: ${e}`);
    }
  }

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
