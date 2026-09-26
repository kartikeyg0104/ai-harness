import fs from "node:fs";
import path from "node:path";
import { openHandsSdkStatus } from "./platform";
import { resolveRunnerConfig, resolveRuntimeId } from "./skill-runner";
import { readConfig } from "./store";
import type { CapabilityStatus, CommandRunner } from "./types";

export interface DoctorCheck {
  name: string;
  status: CapabilityStatus | "available";
  detail: string;
}

export function runDoctor(projectRoot: string, runner: CommandRunner): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push(version("Node", "node", ["--version"], runner));
  checks.push(version("Python", "python3", ["--version"], runner));
  checks.push(version("Git", "git", ["--version"], runner));
  checks.push(binary("Docker", "docker", runner));
  checks.push(binary("uv", "uv", runner));
  checks.push(binary("Semgrep", "semgrep", runner));
  checks.push(binary("Trivy", "trivy", runner));
  checks.push(binary("TruffleHog", "trufflehog", runner));
  checks.push(binary("Playwright", "playwright", runner));
  checks.push(binary("Zoekt", "zoekt", runner));
  checks.push(binary("ast-grep", "ast-grep", runner));
  checks.push(binary("tree-sitter", "tree-sitter", runner));
  checks.push(binary("Qwen", "qwen", runner));
  checks.push(binary("Goose", "goose", runner));
  checks.push(binary("SWE-agent", "sweagent", runner));
  checks.push(binary("mini-swe-agent", "mini", runner));
  const sdk = openHandsSdkStatus();
  checks.push({ name: "OpenHands SDK", status: sdk.status === "INSTALLED" ? "available" : "not-configured", detail: sdk.detail });
  const memlog = path.join(projectRoot, "_bmad", "scripts", "memlog.py");
  const tickets = path.join(projectRoot, "_bmad", "method", "scripts", "tickets.py");
  checks.push({
    name: "BMAD memlog",
    status: fs.existsSync(memlog) ? "available" : "not-configured",
    detail: fs.existsSync(memlog) ? memlog : "Upstream memlog.py is not installed. Install BMAD with npx skills add bmad-code-org/BMAD-METHOD --skill bmad.",
  });
  checks.push({
    name: "BMAD tickets.py",
    status: fs.existsSync(tickets) ? "available" : "not-configured",
    detail: fs.existsSync(tickets) ? tickets : "tickets.py is installed by the ticketing skill into _bmad/method/scripts.",
  });
  const config = readConfig(projectRoot);
  const runnerConfig = resolveRunnerConfig(config);
  const runtimeId = resolveRuntimeId(config);
  checks.push({
    name: "Model runner",
    status: runnerConfig ? "available" : "not-configured",
    detail: runnerConfig ? `BMAD runner command is ${runnerConfig.command}.` : "BMAD runner is unset. Skill steps stay awaiting-model.",
  });
  checks.push({
    name: "Default runtime",
    status: runtimeId ? "available" : "not-configured",
    detail: runtimeId ? `Runtime is ${runtimeId}.` : "No coding runtime configured.",
  });
  const mcp = [".cursor/mcp.json", ".vscode/mcp.json"].map((file) => path.join(projectRoot, file)).find((file) => fs.existsSync(file));
  checks.push({
    name: "MCP",
    status: mcp ? "available" : "not-configured",
    detail: mcp ?? "No MCP config file in the workspace.",
  });
  checks.push({
    name: "Database",
    status: process.env.DATABASE_URL ? "available" : "not-configured",
    detail: process.env.DATABASE_URL ? "DATABASE_URL is set. The value is not shown." : "DATABASE_URL is unset.",
  });
  checks.push({
    name: "Code - OSS extension",
    status: "available",
    detail: "BMAD Next integrates through the VS Code extension API. Code - OSS itself is not forked in this repository.",
  });
  return checks;
}

function version(name: string, bin: string, args: string[], runner: CommandRunner): DoctorCheck {
  const found = runner.which(bin);
  if (!found) return { name, status: "not-available", detail: `${bin} is not on PATH.` };
  const result = runner.run(bin, args, process.cwd(), 8000);
  const detail = (result.stdout || result.stderr).trim().split("\n")[0] ?? found;
  return { name, status: result.exitCode === 0 ? "available" : "blocked", detail };
}

function binary(name: string, bin: string, runner: CommandRunner): DoctorCheck {
  const found = runner.which(bin);
  return found
    ? { name, status: "available", detail: found }
    : { name, status: "not-available", detail: `${bin} is not on PATH.` };
}
