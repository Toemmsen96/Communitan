// Isolated-world content script: reads the server selection from extension storage and hands only the selected
// target to page.js (MAIN world) via DOM events. Strings only (Firefox can't pass objects between worlds).
//   page -> "communitan:hello"            bridge -> "communitan:config" detail = JSON {active, name, url, hostPort, serverKey}
//   page -> "communitan:log" detail = text (shown in this frame's console with a prefix)
// Also drops a saved login made against another server (ServerSwitch.ClearStaleAuth in the mod), see clearStaleAuth.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let config = null;

  function toConfig(model) {
    const entry = model?.servers?.find((s) => s.Name === model.selected);
    if (!entry) return { active: false };
    return {
      active: true,
      name: entry.Name,
      url: `${entry.Scheme}://${entry.Host}:${entry.Port}`,
      hostPort: `${entry.Host}:${entry.Port}`.toLowerCase(),
      serverKey: entry.ServerKey || "defaultkey",
    };
  }

  function send() {
    if (config) document.dispatchEvent(new CustomEvent("communitan:config", { detail: JSON.stringify(config) }));
  }

  // The game keeps its login in Application.persistentDataPath/user.config = key "/idbfs/<hash>/user.config" of the
  // emscripten IDBFS database "/idbfs" (store FILE_DATA), which Unity reads only once the loader runs (after the
  // page's access modal). storage.local "communitanAuthEndpoint" = endpoint that login belongs to; none yet = Official
  // (the game never talked to anything else before the extension).
  async function clearStaleAuth(cfg) {
    const now = cfg.active ? cfg.url : "official";
    const { communitanAuthEndpoint: authed = "official" } = await api.storage.local.get("communitanAuthEndpoint");
    if (authed === now) return;
    const removed = await deleteUserConfig();
    if (removed) console.info(`[Communitan] stored login belongs to ${authed}, not ${now}: deleted it`);
    await api.storage.local.set({ communitanAuthEndpoint: now });
  }

  function deleteUserConfig() {
    return new Promise((resolve) => {
      const req = indexedDB.open("/idbfs");
      // No database yet: don't create one (emscripten creates it with its own version and store).
      req.onupgradeneeded = () => req.transaction.abort();
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("FILE_DATA")) return db.close(), resolve(0);
        const tx = db.transaction("FILE_DATA", "readwrite");
        const store = tx.objectStore("FILE_DATA");
        let removed = 0;
        store.getAllKeys().onsuccess = (e) => {
          for (const key of e.target.result) {
            if (typeof key === "string" && /^\/idbfs\/[^/]+\/user\.config$/.test(key)) {
              store.delete(key);
              removed++;
            }
          }
        };
        tx.oncomplete = () => (db.close(), resolve(removed));
        tx.onerror = tx.onabort = () => (db.close(), resolve(0));
      };
    });
  }

  document.addEventListener("communitan:hello", send);
  document.addEventListener("communitan:log", (e) => console.info("[Communitan]", String(e.detail)));

  api.storage.local.get("communitan").then((got) => {
    config = toConfig(got.communitan);
    send();
    clearStaleAuth(config);
  });

  // page.js pins the target at its first redirected request; later changes only apply before that (or after reload).
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.communitan) {
      config = toConfig(changes.communitan.newValue);
      send();
    }
  });
})();
