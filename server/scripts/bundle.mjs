// Joins tsc's per-file output (build/.tsc) into the single script Nakama loads (build/index.js).
// Sources are global scripts (no imports): Nakama's JS runtime needs InitModule and handlers as top-level functions.
// Order = alphabetical, same as tsc's old `outFile` (top-level code may depend on it).
import fs from "node:fs";
import path from "node:path";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const src = path.join(root, "build", ".tsc");
const out = path.join(root, "build", "index.js");
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js")).sort();
const body = files.map((f) => fs.readFileSync(path.join(src, f), "utf8").replace(/^"use strict";\r?\n/m, "")).join("");
fs.writeFileSync(out, '"use strict";\n' + body);
console.log(`bundled ${files.length} files -> build/index.js`);
