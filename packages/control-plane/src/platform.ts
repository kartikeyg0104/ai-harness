import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { redactSecrets } from "./model-runner";
import type { CommandRunner, DomainEvent } from "./types";

const nodeRequire = createRequire(__filename);

export interface ServiceStatus {
  id: string;
  status: "not-configured" | "configured";
  detail: string;
}

export function serviceStatuses(env: NodeJS.ProcessEnv = process.env): ServiceStatus[] {
  return [
    envStatus("context7", env.CONTEXT7_API_KEY, "CONTEXT7_API_KEY is unset. No documentation is fetched."),
    envStatus("git-mcp", env.GIT_MCP_URL, "GIT_MCP_URL is unset. Git MCP is not called."),
    envStatus("litellm", env.BMAD_LITELLM_URL, "BMAD_LITELLM_URL is unset. Model calls stay on the configured runner."),
    envStatus("langfuse", env.LANGFUSE_HOST && env.LANGFUSE_PUBLIC_KEY ? "set" : "", "Langfuse host and public key are unset. Traces stay local."),
    envStatus("phoenix", env.PHOENIX_COLLECTOR_ENDPOINT, "PHOENIX_COLLECTOR_ENDPOINT is unset. Traces stay local."),
    envStatus("acp", env.BMAD_ACP_URL, "BMAD_ACP_URL is unset. No editor peer is contacted."),
    envStatus("a2a", env.BMAD_A2A_URL, "BMAD_A2A_URL is unset. No agent peer is contacted."),
  ];
}

export function openHandsSdkStatus(): { status: "NOT_CONFIGURED" | "INSTALLED"; detail: string } {
  for (const name of ["@openhands/sdk", "openhands-sdk", "@openhands/agent-sdk"]) {
    try {
      const resolved = nodeRequire.resolve(name);
      return { status: "INSTALLED", detail: `OpenHands SDK package resolved at ${resolved}. Execution stays on the CLI adapter.` };
    } catch {
      continue;
    }
  }
  return { status: "NOT_CONFIGURED", detail: "The OpenHands SDK package is not installed. The CLI adapter is the execution path and stays not-configured until openhands is on PATH." };
}

export function appendTrace(root: string, event: { missionId: string; type: string; at: string; data: Record<string, unknown> }): void {
  const file = path.join(root, ".bmad-next", "traces.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = redactSecrets(JSON.stringify({ ...event, data: event.data }));
  fs.appendFileSync(file, `${line}\n`);
}

export function missionTimeline(events: DomainEvent[]): Array<{ at: string; type: string }> {
  return events.map((event) => ({ at: event.at, type: event.type }));
}

export function updateFileIndex(root: string): { kind: "file-index"; files: number; changed: number; ast: false } {
  const indexPath = path.join(root, ".bmad-next", "file-index.json");
  const previous = fs.existsSync(indexPath) ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as { files?: Record<string, string> }).files ?? {} : {};
  const next: Record<string, string> = {};
  let changed = 0;
  for (const relative of walk(root, root)) {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const signature = previous[relative] === stamp ? stamp : crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    if (previous[relative] !== signature && previous[relative] !== stamp) changed += 1;
    next[relative] = previous[relative] === stamp ? stamp : signature;
  }
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({ kind: "file-index", files: next }, null, 2));
  return { kind: "file-index", files: Object.keys(next).length, changed, ast: false };
}

export function runMutation(runner: CommandRunner, file: string, command: string, args: string[], cwd: string): { status: "measured" | "not-configured"; injected: number; caught: number | null; detail: string } {
  if (!fs.existsSync(file)) return { status: "not-configured", injected: 0, caught: null, detail: "Mutation target does not exist." };
  const original = fs.readFileSync(file, "utf8");
  const mutated = original.includes("===") ? original.replace("===", "!==") : original.includes("return ") ? original.replace("return ", "return undefined; // ") : null;
  if (!mutated || mutated === original) return { status: "not-configured", injected: 0, caught: null, detail: "No safe mutation site was found." };
  try {
    fs.writeFileSync(file, mutated);
    const result = runner.run(command, args, cwd, 30000);
    const caught = result.timedOut || result.exitCode !== 0;
    return { status: "measured", injected: 1, caught: caught ? 1 : 0, detail: caught ? "The test command failed on the mutation." : "The test command still passed. The mutation was not caught." };
  } finally {
    fs.writeFileSync(file, original);
  }
}

export function runChaos(runner: CommandRunner, scenario: "timeout" | "dependency-failure", command: string, args: string[], cwd: string): { scenario: string; timedOut: boolean; exitCode: number | null; detail: string } {
  const timeout = scenario === "timeout" ? 50 : 8000;
  const result = runner.run(command, args, cwd, timeout);
  return {
    scenario,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    detail: result.timedOut ? "The process hit the chaos timeout." : `The process exited ${String(result.exitCode)}.`,
  };
}

function envStatus(id: string, value: string | undefined, missing: string): ServiceStatus {
  const present = (value ?? "").trim().length > 0;
  return { id, status: present ? "configured" : "not-configured", detail: present ? `${id} is configured. A probe is not mission evidence.` : missing };
}

function walk(root: string, dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".bmad-next") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(root, absolute));
    else if (entry.isFile()) found.push(path.relative(root, absolute));
  }
  return found;
}
