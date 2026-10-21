// Isolated-world content script: reads the server selection from extension storage and hands only the selected
// target to page.js (MAIN world) via DOM events. Strings only (Firefox can't pass objects between worlds).
//   page -> "communitan:hello"            bridge -> "communitan:config" detail = JSON {active, name, url, hostPort, serverKey}
//   page -> "communitan:log" detail = text (shown in this frame's console with a prefix)
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

  document.addEventListener("communitan:hello", send);
  document.addEventListener("communitan:log", (e) => console.info("[Communitan]", String(e.detail)));

  api.storage.local.get("communitan").then((got) => {
    config = toConfig(got.communitan);
    send();
  });

  // page.js pins the target at its first redirected request; later changes only apply before that (or after reload).
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.communitan) {
      config = toConfig(changes.communitan.newValue);
      send();
    }
  });
})();
