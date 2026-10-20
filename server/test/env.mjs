// Shared test target. NAKAMA_HOST = "host" or "http(s)://host:port" (same var as smoke.sh), NAKAMA_PORT overrides the port,
// NAKAMA_CONTAINER = container whose log is checked for errors (default server_nakama_1).
const raw = process.env.NAKAMA_HOST || "127.0.0.1";
const url = new URL(raw.includes("://") ? raw : "http://" + raw);
export const SSL = url.protocol === "https:";
export const HOSTNAME = url.hostname;
export const PORT = process.env.NAKAMA_PORT || url.port || (SSL ? "443" : "7350");
export const BASE = `${url.protocol}//${HOSTNAME}:${PORT}`;
export const SERVER_KEY = process.env.NAKAMA_SERVER_KEY || "defaultkey";
export const HTTP_KEY = process.env.NAKAMA_HTTP_KEY || "catan-public-status";
export const CONTAINER = process.env.NAKAMA_CONTAINER || "server_nakama_1";
// podman locally, docker in CI (override with CONTAINER_CLI)
import { execSync as _exec } from "node:child_process";
const _has = (c) => { try { _exec(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch (e) { return false; } };
export const CONTAINER_CLI = process.env.CONTAINER_CLI || (_has("podman") ? "podman" : "docker");
