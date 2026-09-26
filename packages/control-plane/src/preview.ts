import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeProcess } from "./node-process";

/** Marker a browser scenario or NFR command uses for the preview origin. Replaced before anything runs. */
export const PREVIEW_MARKER = "{preview}";

export interface PreviewServer {
  url: string;
  dir: string;
  pid: number | undefined;
  stop(): void;
}

/** Static file server bound to 127.0.0.1. Requests cannot leave the served directory. */
const SERVER = `
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(process.argv[1]);
const ready = process.argv[2];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); } catch { res.writeHead(400); res.end(); return; }
  let file = path.resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(ready + ".tmp", String(server.address().port));
  fs.renameSync(ready + ".tmp", ready);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

/** Starts the preview synchronously so blocking gates (NFR) can use it too. */
export function startPreview(dir: string, timeoutMs = 10000): PreviewServer {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "index.html"))) throw new Error(`No index.html in ${root}, so there is nothing to serve.`);
  const ready = path.join(os.tmpdir(), `bmad-preview-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.port`);
  const node = nodeProcess();
  const child = spawn(node.command, ["-e", SERVER, root, ready], { env: node.env, stdio: "ignore" });
  let failed: Error | null = null;
  child.on("error", (error) => {
    failed = error;
  });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null && !failed) Atomics.wait(pause, 0, 0, 50);
  if (!fs.existsSync(ready)) {
    child.kill("SIGTERM");
    throw new Error(`Preview server for ${root} did not start.`);
  }
  const port = Number(fs.readFileSync(ready, "utf8"));
  fs.rmSync(ready, { force: true });
  return {
    url: `http://127.0.0.1:${port}/`,
    dir: root,
    pid: child.pid,
    stop: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

/** Replaces the preview marker with the served origin. A marker followed by a path keeps that path. */
export function withPreview(value: string, url: string): string {
  return value.split(PREVIEW_MARKER).join(url.replace(/\/$/, ""));
}

/**
 * The directory a ticket's web app is served from: a declared layer holding index.html, else the directory of
 * a changed index.html, else the worktree root when it holds index.html.
 */
export function previewDir(worktree: string, layers: string[], changedFiles: string[]): string | null {
  const root = path.resolve(worktree);
  const inside = (dir: string) => dir === root || dir.startsWith(root + path.sep);
  for (const layer of layers) {
    const dir = path.resolve(root, layer);
    if (inside(dir) && fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  const changed = changedFiles
    .map((file) => path.resolve(root, file.replace(/\/$/, "")))
    .filter((file) => inside(file) && path.basename(file) === "index.html" && fs.existsSync(file))
    .sort((left, right) => left.length - right.length)[0];
  if (changed) return path.dirname(changed);
  return fs.existsSync(path.join(root, "index.html")) ? root : null;
}

/** Latency probe: median of five GETs against the served URL, printed as a BMAD-NFR-VALUE in milliseconds. */
export const LATENCY_PROBE = `
const http = require("node:http");
const url = process.argv[1];
const once = () => new Promise((resolve, reject) => {
  const started = process.hrtime.bigint();
  http.get(url, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200 ? Number(process.hrtime.bigint() - started) / 1e6 : NaN)); }).on("error", reject);
});
(async () => {
  const samples = [];
  for (let i = 0; i < 5; i += 1) samples.push(await once());
  if (samples.some((value) => Number.isNaN(value))) { console.error("A request did not return 200."); process.exit(1); }
  samples.sort((a, b) => a - b);
  console.log("samples_ms=" + samples.map((value) => value.toFixed(2)).join(","));
  console.log("BMAD-NFR-VALUE: " + samples[2].toFixed(2));
})().catch((error) => { console.error(error.message); process.exit(1); });
`;
