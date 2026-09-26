#!/usr/bin/env node
/**
 * Live OpenCode probe. This is not mission evidence.
 * Completion is step_finish reason stop. A written file without that event is not a pass.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = process.env.BMAD_MODEL || "nvidia/google/gemma-3-4b-it";
const timeoutMs = Number(process.env.BMAD_PROBE_TIMEOUT || 70000);
const opencode = process.env.OPENCODE_BIN || "opencode";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-opencode-probe-"));
const prompt = [
  "Create exactly one file named health.js in this directory.",
  "The file must contain: function health() { return { ok: true }; }",
  "The file must contain this comment on its own line: // BMAD-TICKET-STATUS: built",
  "Then stop. Do not create any other file.",
].join(" ");

const args = ["run", "--pure", "--auto", "--format", "json", "--dir", root, "--model", model, prompt];
const child = spawn(opencode, args, {
  cwd: root,
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agent: { build: { steps: 6 } },
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let finished = false;
const started = Date.now();
const timer = setTimeout(() => {
  child.kill("SIGTERM");
}, timeoutMs);

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const events = [];
  for (const line of stdout.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start));
      const part = parsed.part && typeof parsed.part === "object" ? parsed.part : parsed;
      const type = String(parsed.type ?? part.type ?? "");
      if (type === "step_finish" || type === "step-finish") events.push({ type, reason: part.reason ?? parsed.reason ?? null });
    } catch {
      // Non-JSON log lines are ignored.
    }
  }
  const file = path.join(root, "health.js");
  const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const stopped = events.some((event) => event.reason === "stop");
  const report = {
    probe: "opencode-reliability",
    missionEvidence: false,
    model,
    directory: root,
    available: true,
    promptAccepted: stdout.length > 0 || stderr.length > 0 || code !== null,
    fileWritten: body.includes("function health"),
    protocolComment: /BMAD-TICKET-STATUS:\s*built/.test(body),
    stepFinishStop: stopped,
    processTerminated: code !== null || signal !== null,
    exitCode: code,
    signal,
    durationMs: Date.now() - started,
    timedOut: signal === "SIGTERM",
    stdoutBytes: stdout.length,
    stderrTail: stderr.slice(-500),
    stdoutTail: stdout.slice(-800),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = stopped && report.fileWritten && report.processTerminated ? 0 : 1;
});
