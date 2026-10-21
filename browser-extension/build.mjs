#!/usr/bin/env node
// Builds dist/chrome and dist/firefox (unpacked) + zips from src/ and manifest.json. No dependencies.
// Usage: node build.mjs [version]   (default: manifest.json version)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const base = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (process.argv[2]) base.version = process.argv[2];

// Chrome: background.service_worker. Firefox: background.scripts + gecko id (MAIN-world content scripts need 128+).
const targets = {
  chrome: (m) => {
    delete m.browser_specific_settings;
    if (m.background) m.background = { service_worker: m.background.script };
    return m;
  },
  firefox: (m) => {
    if (m.background) m.background = { scripts: [m.background.script] };
    return m;
  },
};

rmSync(dist, { recursive: true, force: true });
for (const [name, patch] of Object.entries(targets)) {
  const out = join(dist, name);
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "src"), out, { recursive: true });
  cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(patch(structuredClone(base)), null, 2) + "\n");
  const zip = join(dist, `communitan-${name}-${base.version}.zip`);
  execFileSync("zip", ["-qr", zip, "."], { cwd: out });
  console.log(`${name}: ${out}  ${zip}`);
}
