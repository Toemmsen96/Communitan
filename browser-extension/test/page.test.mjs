// node --test test/  — runs src/page.js in a fake page (vm) with recording fetch/XHR/WebSocket stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const SRC = readFileSync(new URL("../src/page.js", import.meta.url), "utf8");
const PROD = "https://catan-prod1.us-east1-c.nakamacloud.io:443";
const PROD_AUTH = "Basic " + btoa("3RKm7q5qvTPw:");
const TARGET = { active: true, name: "Local", url: "http://127.0.0.1:7350", hostPort: "127.0.0.1:7350", serverKey: "defaultkey" };

// Just enough DOM for the notices (closed shadow root of elements with text, children and click listeners).
class El {
  constructor(tag) { Object.assign(this, { tag, children: [], listeners: {}, style: {}, className: "", text: "" }); }
  append(...items) {
    for (let x of items) {
      if (typeof x === "string") {
        const t = new El("#text");
        t.text = x;
        x = t;
      }
      x.parent = this;
      this.children.push(x);
    }
  }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  attachShadow() { return (this.shadow = new El("#shadow")); }
  addEventListener(type, f) { this.listeners[type] = f; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  find(pred) { return pred(this) ? this : this.children.map((c) => c.find(pred)).find(Boolean); }
}

function page(config, { bridge = true, respond = () => "{}" } = {}) {
  const calls = { fetch: [], warm: [], xhr: [], ws: [], log: [] };
  const document = new EventTarget();
  document.documentElement = new El("html");
  document.body = null;
  document.createElement = (tag) => new El(tag);
  // Text currently shown by the notices ("" = nothing).
  calls.ui = () => (document.documentElement.children[0]?.shadow.children.slice(1).map((c) => c.textContent).join(" | ") ?? "");
  calls.click = (label) => document.documentElement.children[0].shadow.find((e) => e.tag === "button" && e.textContent === label).listeners.click();
  document.addEventListener("communitan:log", (e) => calls.log.push(e.detail));
  if (bridge) {
    const send = () => document.dispatchEvent(new CustomEvent("communitan:config", { detail: JSON.stringify(config) }));
    document.addEventListener("communitan:hello", send);
  }
  class XMLHttpRequest {
    open(method, url) { this.rec = { method, url, headers: {} }; calls.xhr.push(this.rec); }
    setRequestHeader(n, v) { this.rec.headers[n.toLowerCase()] = v; }
    send(body) { this.rec.body = body; this.rec.sent = true; }
  }
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; calls.ws.push(url); }
  }
  const fetch = async (input, init = {}) => {
    if (init.mode === "no-cors") return calls.warm.push(input), new Response(null);
    const req = new Request(input, init);
    calls.fetch.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body: init.body });
    return new Response(respond(req.url));
  };
  const window = {
    document, fetch, XMLHttpRequest, WebSocket, location: { href: "https://catanuniverse.com/game/" },
    setTimeout: (f, ms) => setTimeout(f, ms).unref(), URL, Request, Headers, Response, CustomEvent, TextEncoder, crypto, btoa,
  };
  window.window = window;
  vm.runInNewContext(SRC, window);
  return { window, calls };
}

const salted = (id, hp) => createHash("sha256").update(`${id}|${hp}`).digest("hex").slice(0, 40);

test("fetch to official host is redirected with target key and salted device id", async () => {
  const { window, calls } = page(TARGET);
  await window.fetch(`${PROD}/v2/account/authenticate/device?create=true`, {
    method: "POST",
    headers: { Authorization: PROD_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "dev-123", vars: {} }),
  });
  const c = calls.fetch[0];
  assert.equal(c.url, "http://127.0.0.1:7350/v2/account/authenticate/device?create=true");
  assert.equal(c.auth, "Basic " + btoa("defaultkey:"));
  assert.equal(JSON.parse(c.body).id, salted("dev-123", "127.0.0.1:7350"));
  assert.match(calls.log[0], /redirecting .* -> http:\/\/127\.0\.0\.1:7350/);
});

test("session bearer token and RPC body pass through unchanged", async () => {
  const { window, calls } = page(TARGET);
  const body = JSON.stringify({ "@class": ".LogEventRequest", eventKey: "X" });
  await window.fetch(new Request(`${PROD}/v2/rpc/X`, { method: "POST", headers: { Authorization: "Bearer abc" }, body }));
  assert.equal(calls.fetch[0].url, "http://127.0.0.1:7350/v2/rpc/X");
  assert.equal(calls.fetch[0].auth, "Bearer abc");
  assert.equal(calls.fetch[0].body, body);
});

test("other hosts and Official selection are untouched", async () => {
  const { window, calls } = page({ active: false });
  await window.fetch("https://cdn.catancdn.de/x.bundle");
  await window.fetch(`${PROD}/v2/account/authenticate/email`, { method: "POST", headers: { Authorization: PROD_AUTH }, body: "{}" });
  assert.equal(calls.fetch[0].url, "https://cdn.catancdn.de/x.bundle");
  assert.equal(calls.fetch[1].url, new URL(`${PROD}/v2/account/authenticate/email`).href);
  assert.equal(calls.fetch[1].auth, PROD_AUTH);
});

test("WebSocket follows the target scheme (https -> wss, http -> ws)", () => {
  const { window, calls } = page(TARGET);
  new window.WebSocket("wss://catan-prod1.us-east1-c.nakamacloud.io:443/ws?lang=en&status=true&token=t");
  assert.equal(calls.ws[0], "ws://127.0.0.1:7350/ws?lang=en&status=true&token=t");
  const tls = page({ ...TARGET, url: "https://catan.example.org:443", hostPort: "catan.example.org:443" });
  const s = new tls.window.WebSocket("wss://catan-prod1.us-east1-c.nakamacloud.io/ws?token=t");
  assert.equal(tls.calls.ws[0], "wss://catan.example.org/ws?token=t");
  assert.ok(s instanceof tls.window.WebSocket);
});

test("XHR is rewritten synchronously once config is known", async () => {
  const { window, calls } = page(TARGET);
  const x = new window.XMLHttpRequest();
  x.open("POST", `${PROD}/v2/account/authenticate/device`);
  x.setRequestHeader("Authorization", PROD_AUTH);
  x.send(JSON.stringify({ id: "d" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.xhr[0].url, "http://127.0.0.1:7350/v2/account/authenticate/device");
  assert.equal(calls.xhr[0].headers.authorization, "Basic " + btoa("defaultkey:"));
  assert.equal(JSON.parse(calls.xhr[0].body).id, salted("d", "127.0.0.1:7350"));
});

test("early fetch waits for the bridge; config change after first redirect is ignored", async () => {
  const { window, calls } = page(TARGET, { bridge: false });
  const pending = window.fetch(`${PROD}/healthcheck`);
  window.document.dispatchEvent(new CustomEvent("communitan:config", { detail: JSON.stringify(TARGET) }));
  await pending;
  assert.equal(calls.fetch[0].url, "http://127.0.0.1:7350/healthcheck");
  window.document.dispatchEvent(new CustomEvent("communitan:config", { detail: JSON.stringify({ active: false }) }));
  await window.fetch(`${PROD}/healthcheck`);
  assert.equal(calls.fetch[1].url, "http://127.0.0.1:7350/healthcheck");
});

test("selected server is touched once at load (local network access prompt); Official is not", () => {
  const { window, calls } = page(TARGET);
  window.document.dispatchEvent(new CustomEvent("communitan:config", { detail: JSON.stringify(TARGET) }));
  assert.deepEqual(calls.warm, ["http://127.0.0.1:7350/healthcheck"]);
  assert.deepEqual(page({ active: false }).calls.warm, []);
});

const rpcResponse = (id, scriptData) => JSON.stringify({ id, payload: JSON.stringify({ "@class": ".X", scriptData }) });
const tick = () => new Promise((r) => setTimeout(r, 10));

test("password hint is shown on a community server until dismissed; not on Official", () => {
  const { calls } = page(TARGET);
  assert.match(calls.ui(), /Community server “Local” — do not use your official Catan password/);
  calls.click("✕");
  assert.equal(calls.ui(), "");
  assert.equal(page({ active: false }).calls.ui(), "");
});

test("password hint goes away after a successful login", async () => {
  const { window, calls } = page(TARGET);
  await window.fetch(`${PROD}/v2/account/authenticate/email?create=false`, { method: "POST", headers: { Authorization: PROD_AUTH }, body: "{}" });
  assert.equal(calls.ui(), "");
});

test("needsEmailVerification -> activation code fetched once with the session and shown", async () => {
  const respond = (url) =>
    url.endsWith("/ACCOUNT_RESEND_ACTIVATION_CODE")
      ? rpcResponse("ACCOUNT_RESEND_ACTIVATION_CODE", { code: "04711", delivery: "ingame" })
      : rpcResponse("AccountDetailsRequest", { needsEmailVerification: true });
  const { window, calls } = page(TARGET, { respond });
  calls.click("✕");
  for (let i = 0; i < 2; i++)
    await window.fetch(`${PROD}/v2/rpc/AccountDetailsRequest`, { method: "POST", headers: { Authorization: "Bearer s1" }, body: '"{}"' });
  await tick();
  const resend = calls.fetch.filter((c) => c.url.endsWith("/v2/rpc/ACCOUNT_RESEND_ACTIVATION_CODE"));
  assert.equal(resend.length, 1);
  assert.equal(resend[0].url, "http://127.0.0.1:7350/v2/rpc/ACCOUNT_RESEND_ACTIVATION_CODE");
  assert.equal(resend[0].auth, "Bearer s1");
  assert.equal(JSON.parse(JSON.parse(resend[0].body)).eventKey, "ACCOUNT_RESEND_ACTIVATION_CODE");
  assert.match(calls.ui(), /Activation code.*sends no emails.*04711/);
  calls.click("OK");
  assert.equal(calls.ui(), "");
});

test("the game's own resend shows the code again; verified accounts show nothing", async () => {
  let sd = { code: "12345", delivery: "ingame" };
  const { window, calls } = page(TARGET, { respond: () => rpcResponse("ACCOUNT_RESEND_ACTIVATION_CODE", sd) });
  calls.click("✕");
  const resend = () => window.fetch(`${PROD}/v2/rpc/ACCOUNT_RESEND_ACTIVATION_CODE`, { method: "POST", headers: { Authorization: "Bearer s" }, body: '"{}"' });
  await resend();
  await tick();
  assert.match(calls.ui(), /12345/);
  sd = { delivery: "auto" };
  await resend();
  await tick();
  assert.match(calls.ui(), /^No activation needed/);
  calls.click("OK");
  const other = page(TARGET, { respond: () => rpcResponse("AccountDetailsRequest", { needsEmailVerification: false }) });
  other.calls.click("✕");
  await other.window.fetch(`${PROD}/v2/rpc/AccountDetailsRequest`, { method: "POST", headers: { Authorization: "Bearer s" }, body: '"{}"' });
  await tick();
  assert.equal(other.calls.fetch.length, 1);
  assert.equal(other.calls.ui(), "");
});
