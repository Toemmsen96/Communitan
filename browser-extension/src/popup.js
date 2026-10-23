import * as S from "./servers.js";

const $ = (id) => document.getElementById(id);
const inTab = new URLSearchParams(location.search).has("tab");
let model = S.emptyModel();
let editing = null; // entry being edited, or null when adding
let pending = null; // entry waiting for the community-server warning
const pings = new Map(); // url -> ping result | "pending"

async function init() {
  model = await S.load();
  render();
  if (new URLSearchParams(location.search).has("import")) $("import-file").click();
}

function render() {
  const list = $("servers");
  list.replaceChildren(row({ Name: S.OFFICIAL }), ...model.servers.map(row));
}

function row(entry) {
  const official = entry.Name === S.OFFICIAL;
  const li = document.createElement("li");
  li.className = "server" + (model.selected === entry.Name ? " selected" : "");

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "server";
  radio.checked = model.selected === entry.Name;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = entry.Name;
  const meta = document.createElement("span");
  meta.className = "meta";
  li.append(radio, name);

  if (official) {
    meta.textContent = "USM servers (no redirect)";
  } else {
    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openForm(entry);
    });
    li.append(edit);
    renderMeta(meta, entry);
  }
  li.append(meta);
  li.addEventListener("click", () => select(entry));
  return li;
}

function renderMeta(meta, entry) {
  const key = S.url(entry);
  const p = pings.get(key);
  if (p === undefined) {
    pings.set(key, "pending");
    S.ping(entry).then((r) => {
      pings.set(key, r);
      render();
    });
  }
  const dot = document.createElement("span");
  dot.className = "dot" + (p && p !== "pending" ? (p.ok ? " ok" : " bad") : "");
  let text = S.address(entry);
  if (p && p !== "pending") {
    text += p.ok ? ` · ${p.ms} ms` : ` · ${p.error}`;
    const status = p.ok ? S.describeStatus(p.status) : "";
    if (status) text += ` · ${status}`;
    if (p.ok && p.status?.motd) text += ` · ${p.status.motd}`;
  }
  meta.append(dot, text);
  if (S.isLoopback(entry.Host) && model.selected === entry.Name) {
    meta.append(" · on first load the browser asks to access this device: click Allow");
  }
  if (S.unencrypted(entry)) {
    const tag = document.createElement("span");
    tag.className = "tag";
    // The game page is https: browsers block plain-http requests to anything but localhost (mixed content).
    tag.textContent = " · NOT ENCRYPTED · browser needs https";
    meta.append(tag);
  }
}

async function select(entry) {
  if (entry.Name === model.selected) return;
  if (entry.Name !== S.OFFICIAL && !model.acknowledged.includes(S.hostPort(entry))) {
    pending = entry;
    $("warning-http").hidden = !S.unencrypted(entry);
    $("warning").hidden = false;
    $("form").hidden = true;
    return;
  }
  await applySelection(entry.Name);
}

async function applySelection(name) {
  model.selected = name;
  await S.save(model);
  $("reload").hidden = false;
  render();
}

$("warning-ok").addEventListener("click", async () => {
  model.acknowledged.push(S.hostPort(pending));
  $("warning").hidden = true;
  await applySelection(pending.Name);
  pending = null;
});
$("warning-cancel").addEventListener("click", () => {
  pending = null;
  $("warning").hidden = true;
});

function openForm(entry) {
  editing = entry;
  $("form-title").textContent = entry ? "Edit server" : "Add server";
  $("f-name").value = entry?.Name ?? "";
  $("f-address").value = entry ? S.address(entry) : "";
  $("f-key").value = entry && entry.ServerKey !== S.DEFAULT_KEY ? entry.ServerKey : "";
  $("f-delete").hidden = !entry;
  $("f-error").hidden = true;
  $("warning").hidden = true;
  $("form").hidden = false;
  $("f-name").focus();
}

function formError(text) {
  $("f-error").textContent = text;
  $("f-error").hidden = false;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  const addr = S.parseAddress($("f-address").value);
  if (!name || name === S.OFFICIAL) return formError(`Name can't be empty or "${S.OFFICIAL}"`);
  if (model.servers.some((s) => s.Name === name && s !== editing)) return formError("A server with that name exists");
  if (addr.error) return formError(addr.error);
  const target = editing ?? {};
  if (editing && model.selected === editing.Name) model.selected = name;
  Object.assign(target, {
    Name: name,
    Host: addr.host,
    Port: addr.port,
    Scheme: addr.scheme,
    ServerKey: $("f-key").value.trim() || S.DEFAULT_KEY,
  });
  if (!editing) model.servers.push(target);
  await S.save(model);
  model = await S.load();
  $("form").hidden = true;
  render();
});

$("f-delete").addEventListener("click", async () => {
  model.servers = model.servers.filter((s) => s !== editing);
  await S.save(model);
  model = await S.load();
  $("form").hidden = true;
  render();
});
$("f-cancel").addEventListener("click", () => ($("form").hidden = true));
$("add").addEventListener("click", () => openForm(null));

// Firefox closes the popup when a file dialog opens, so import runs from a tab.
$("import").addEventListener("click", async () => {
  if (inTab) return $("import-file").click();
  await S.api.tabs.create({ url: S.api.runtime.getURL("popup.html?tab&import") });
  window.close();
});

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = S.normalize(JSON.parse(await file.text()));
    for (const s of imported.servers) {
      const i = model.servers.findIndex((x) => x.Name === s.Name);
      if (i >= 0) model.servers[i] = s;
      else model.servers.push(s);
    }
    // Acknowledgements made in the game count here too; the selection stays as it is.
    model.acknowledged = [...new Set([...model.acknowledged, ...imported.acknowledged])];
    await S.save(model);
    model = await S.load();
    render();
  } catch {
    alert("Not a valid servers.json");
  }
  e.target.value = "";
});

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Communitan.servers.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

init();
