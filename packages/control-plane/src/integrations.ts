import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "./types";

export interface BoundaryResult {
  id: string;
  status: "NOT_CONFIGURED" | "COMPLETED" | "FAILED" | "TIMEOUT" | "INVALID";
  detail: string;
  exitCode: number | null;
}

const MODULES = {
  loop: { binary: "bmad-loop", repository: "https://github.com/bmad-code-org/bmad-loop" },
  tea: { binary: "bmad-tea", repository: "https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise" },
  builder: { binary: "bmad-builder", repository: "https://github.com/bmad-code-org/bmad-builder" },
  promptfoo: { binary: "promptfoo", repository: "https://github.com/promptfoo/promptfoo" },
} as const;

export function upstreamModule(runner: CommandRunner, id: keyof typeof MODULES, args: string[], cwd: string): BoundaryResult {
  const module = MODULES[id];
  const binary = runner.which(module.binary);
  if (!binary) {
    return { id, status: "NOT_CONFIGURED", detail: `${module.binary} is not on PATH. ${module.repository} is not invoked. The local control plane is not this upstream tool.`, exitCode: null };
  }
  const result = runner.run(binary, args, cwd, 30000);
  if (result.timedOut) return { id, status: "TIMEOUT", detail: `${module.binary} timed out. Exit is not a pass.`, exitCode: result.exitCode };
  if (result.exitCode !== 0) return { id, status: "FAILED", detail: (result.stderr || result.stdout).trim() || `${module.binary} failed.`, exitCode: result.exitCode };
  return { id, status: "COMPLETED", detail: "The process exited 0. That is process completion, not a BMAD gate pass.", exitCode: 0 };
}

export function acpInitialize(command: string | undefined, args: string[], cwd: string): BoundaryResult {
  if (!command?.trim()) {
    return { id: "acp", status: "NOT_CONFIGURED", detail: "BMAD_ACP_COMMAND is unset. No ACP peer was started.", exitCode: null };
  }
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "bmad-next", version: "0.1.0" },
    },
  };
  const result = spawnSync(command, args, { cwd, input: `${JSON.stringify(request)}\n`, encoding: "utf8", timeout: 8000 });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return { id: "acp", status: "TIMEOUT", detail: "ACP initialize timed out.", exitCode: result.status };
  }
  const line = (result.stdout ?? "").split("\n").find((item) => item.trim().startsWith("{"));
  if (!line) return { id: "acp", status: "INVALID", detail: "ACP peer returned no JSON-RPC message.", exitCode: result.status };
  try {
    const message = JSON.parse(line) as { result?: { protocolVersion?: number } };
    if (message.result?.protocolVersion !== 1) return { id: "acp", status: "INVALID", detail: "ACP initialize did not return protocolVersion 1.", exitCode: result.status };
  } catch {
    return { id: "acp", status: "INVALID", detail: "ACP initialize output was not JSON.", exitCode: result.status };
  }
  return { id: "acp", status: "COMPLETED", detail: "ACP initialize returned protocolVersion 1. This is not mission evidence.", exitCode: result.status };
}

export async function readAgentCard(url: string | undefined, fetchImpl: typeof fetch = fetch): Promise<BoundaryResult> {
  if (!url?.trim()) return { id: "a2a", status: "NOT_CONFIGURED", detail: "BMAD_A2A_URL is unset. No agent card was requested.", exitCode: null };
  let response: Response;
  try {
    response = await fetchImpl(new URL("/.well-known/agent.json", url).toString());
  } catch (error) {
    return { id: "a2a", status: "FAILED", detail: error instanceof Error ? error.message : String(error), exitCode: null };
  }
  if (!response.ok) return { id: "a2a", status: "FAILED", detail: `Agent card request returned ${response.status}.`, exitCode: response.status };
  let card: { name?: string; url?: string };
  try {
    card = (await response.json()) as { name?: string; url?: string };
  } catch {
    return { id: "a2a", status: "INVALID", detail: "Agent card was not JSON.", exitCode: response.status };
  }
  if (!card.name || !card.url) return { id: "a2a", status: "INVALID", detail: "Agent card is missing name or url.", exitCode: response.status };
  return { id: "a2a", status: "COMPLETED", detail: `Agent card ${card.name} at ${card.url}. This is not a completed task.`, exitCode: response.status };
}

export function textualSymbols(root: string): { kind: "textual"; symbols: string[] } {
  const symbols: string[] = [];
  for (const file of walkSource(root, root).slice(0, 200)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)) symbols.push(`${file}:${match[1]}`);
    for (const match of text.matchAll(/^(?:export\s+)?class\s+([A-Za-z0-9_]+)/gm)) symbols.push(`${file}:${match[1]}`);
  }
  return { kind: "textual", symbols };
}

export function toolProbe(runner: CommandRunner, binary: string, args: string[], cwd: string): BoundaryResult {
  if (!runner.which(binary)) return { id: binary, status: "NOT_CONFIGURED", detail: `${binary} is not on PATH. No query ran.`, exitCode: null };
  const result = runner.run(binary, args, cwd, 15000);
  if (result.timedOut) return { id: binary, status: "TIMEOUT", detail: `${binary} timed out.`, exitCode: result.exitCode };
  if (result.exitCode !== 0) return { id: binary, status: "FAILED", detail: (result.stderr || result.stdout).trim() || `${binary} failed.`, exitCode: result.exitCode };
  return { id: binary, status: "COMPLETED", detail: (result.stdout || "").trim().slice(0, 500) || `${binary} exited 0.`, exitCode: 0 };
}

export function diagnoseCiLog(text: string): { failures: string[]; push: "NOT_CONFIGURED" } {
  const failures = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /error TS\d+|npm error|FAIL\s|AssertionError|ELIFECYCLE/.test(line))
    .slice(0, 20);
  return { failures, push: "NOT_CONFIGURED" };
}

function walkSource(root: string, dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === ".bmad-next") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkSource(root, absolute));
    else if (/\.(ts|js|tsx|jsx)$/.test(entry.name)) found.push(path.relative(root, absolute));
  }
  return found;
}
