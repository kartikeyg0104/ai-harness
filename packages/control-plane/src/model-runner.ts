import fs from "node:fs";
import path from "node:path";
import type { BmadRunnerConfig, CommandRunner } from "./types";

export interface ModelRequest {
  skillId: string;
  system?: string;
  prompt: string;
  input: unknown;
  cwd: string;
  timeoutMs: number;
}

export interface ModelResult {
  status: "completed" | "failed" | "timeout" | "not-configured";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs?: number;
}

export interface ModelRunner {
  id: string;
  available(): Promise<boolean>;
  run(request: ModelRequest): Promise<ModelResult>;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"]);

export function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)(\S+)/gi, "$1[redacted]");
}

/**
 * The last complete JSON object printed to stdout. A coding CLI prints the model's intermediate text before its
 * final reply, so the contract object is the last one. It still has to match the contract and name files that exist.
 */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  for (let end = clean.lastIndexOf("}"); end >= 0; end = clean.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;
    for (let index = end; index >= 0; index -= 1) {
      const char = clean[index];
      if (char === '"' && clean[index - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (char === "}") depth += 1;
      else if (char === "{") depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(clean.slice(index, end + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          // Not a complete object here; try an earlier closing brace.
        }
        break;
      }
    }
  }
  return null;
}

export function parseRunnerArgs(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("BMAD_RUNNER_ARGS must be a JSON array of strings.");
    }
    return parsed.filter((item): item is string => typeof item === "string");
  }
  return text.split(/\s+/).filter((item) => item.length > 0);
}

export function safeModelName(value: string | undefined): string | null {
  const model = (value ?? "").trim();
  if (!model) return null;
  if (/(api[_-]?key|token|secret|password)/i.test(model)) return null;
  return model;
}

function insideRoot(root: string, cwd: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(cwd);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Process boundary for a model runner. Arguments are an array.
 * A completed process is not a completed BMAD artifact.
 */
export class CommandModelRunner implements ModelRunner {
  readonly id: string;

  constructor(
    private readonly runner: CommandRunner,
    private readonly config: BmadRunnerConfig | null,
    private readonly root: string,
  ) {
    this.id = config?.command ?? "unconfigured";
  }

  available(): Promise<boolean> {
    return Promise.resolve(this.isAvailable());
  }

  run(request: ModelRequest): Promise<ModelResult> {
    return Promise.resolve(this.runSync(request));
  }

  isAvailable(): boolean {
    const command = this.config?.command;
    if (!command) return false;
    if (path.isAbsolute(command)) return fs.existsSync(command);
    return Boolean(this.runner.which(command));
  }

  runSync(request: ModelRequest): ModelResult {
    const command = this.config?.command;
    if (!command) {
      return { status: "not-configured", stdout: "", stderr: "No model runner is configured.", exitCode: null };
    }
    if (!this.isAvailable()) {
      return { status: "not-configured", stdout: "", stderr: `Model runner ${command} is not available.`, exitCode: null };
    }
    const inputPath = typeof request.input === "string" ? request.input : "";
    let sawPlaceholder = false;
    const args = (this.config?.args ?? []).map((arg) => {
      if (arg === "{prompt}") {
        sawPlaceholder = true;
        return request.prompt;
      }
      if (arg === "{input}") {
        sawPlaceholder = true;
        return inputPath;
      }
      return arg;
    });
    if (SHELLS.has(path.basename(command)) && args.some((arg) => arg === "-c" || arg === "/c")) {
      return { status: "failed", stdout: "", stderr: "Shell command execution is refused. Pass an argument array.", exitCode: null };
    }
    if (!insideRoot(this.root, request.cwd)) {
      return { status: "failed", stdout: "", stderr: "Model runner cwd is outside the mission workspace.", exitCode: null };
    }
    if (!sawPlaceholder) {
      if (inputPath.trim()) args.push(request.skillId, inputPath);
      else args.push(request.skillId);
    }
    const result = this.runner.run(command, args, request.cwd, request.timeoutMs);
    if (result.timedOut) {
      return { status: "timeout", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
    }
    if (result.exitCode !== 0) {
      return { status: "failed", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
    }
    return { status: "completed", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
  }
}
