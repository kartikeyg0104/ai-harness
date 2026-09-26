import fs from "node:fs";
import path from "node:path";
import { probePlaywright } from "./browser";
import { openHandsSdkStatus } from "./platform";
import { resolveAttackerConfig } from "./attack";
import { resolveReviewerConfig } from "./reviewer";
import { resolveRunnerConfig, resolveRuntimeId } from "./skill-runner";
import { readConfig } from "./store";
import type { BmadRunnerConfig, CapabilityStatus, CommandRunner } from "./types";

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
  checks.push(binary("OpenCode", "opencode", runner));
  checks.push(binary("Docker", "docker", runner));
  checks.push(binary("uv", "uv", runner));
  checks.push(binary("Semgrep", "semgrep", runner));
  checks.push(binary("Trivy", "trivy", runner));
  checks.push(binary("TruffleHog", "trufflehog", runner));
  checks.push(playwrightCheck(runner));
  checks.push(binary("Zoekt", "zoekt", runner));
  checks.push(binary("ast-grep", "ast-grep", runner));
  checks.push(binary("tree-sitter", "tree-sitter", runner));
  checks.push(binary("Qwen", "qwen", runner));
  checks.push(binary("Goose", "goose", runner));
  checks.push(binary("SWE-agent", "sweagent", runner));
  checks.push(binary("mini-swe-agent", "mini", runner));
  const sdk = openHandsSdkStatus();
  checks.push({ name: "OpenHands SDK", status: sdk.status === "INSTALLED" ? "available" : "not-configured", detail: sdk.detail });
  checks.push(envCheck("ACP", process.env.BMAD_ACP_COMMAND, "BMAD_ACP_COMMAND is unset. No ACP peer is started."));
  checks.push(envCheck("A2A", process.env.BMAD_A2A_URL, "BMAD_A2A_URL is unset. No agent card is requested."));
  checks.push(envCheck("Langfuse", process.env.LANGFUSE_HOST && process.env.LANGFUSE_PUBLIC_KEY ? "set" : "", "Langfuse host and public key are unset. Traces stay in .bmad-next/traces.jsonl."));
  checks.push(envCheck("LiteLLM", process.env.BMAD_LITELLM_URL, "BMAD_LITELLM_URL is unset. Model calls stay on the configured runner."));
  const memlog = path.join(projectRoot, "_bmad", "scripts", "memlog.py");
  checks.push({
    name: "BMAD memlog",
    status: fs.existsSync(memlog) ? "available" : "not-configured",
    detail: fs.existsSync(memlog) ? memlog : "Upstream memlog.py is not installed. Install BMAD with npx skills add bmad-code-org/BMAD-METHOD --skill bmad.",
  });
  checks.push(ticketingCheck(projectRoot));
  const config = readConfig(projectRoot);
  const runnerConfig = resolveRunnerConfig(config);
  const runtimeId = resolveRuntimeId(config);
  checks.push({
    name: "Model runner",
    status: runnerConfig ? "available" : "not-configured",
    detail: runnerConfig ? `BMAD runner command is ${runnerConfig.command}.` : "BMAD runner is unset. Skill steps stay awaiting-model.",
  });
  checks.push(roleCheck("Reviewer runner", resolveReviewerConfig(config), runnerConfig, runner, "BMAD_REVIEWER_RUNNER is unset. Review stays NOT_CONFIGURED."));
  checks.push(roleCheck("Attacker runner", resolveAttackerConfig(config), runnerConfig, runner, "BMAD_ATTACK_RUNNER is unset. Attack stays NOT_CONFIGURED. It does not fall back to the coding runner."));
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

const LEGACY_TICKETS = [
  ["_bmad", "method", "scripts", "tickets.py"],
  ["_bmad", "scripts", "tickets.py"],
];
const TICKETING_SKILLS = ["bmad-create-epics-and-stories", "bmad-sprint-planning"];

/**
 * BMad releases before 6.12 shipped tickets.py. 6.12 moved ticketing into skills listed in
 * _bmad/_config/skill-manifest.csv and ships no tickets.py, so its absence is not a gap there.
 */
export function ticketingCheck(projectRoot: string): DoctorCheck {
  const legacy = LEGACY_TICKETS.map((parts) => path.join(projectRoot, ...parts)).find((file) => fs.existsSync(file));
  if (legacy) return { name: "BMAD ticketing", status: "available", detail: legacy };
  const manifest = path.join(projectRoot, "_bmad", "_config", "skill-manifest.csv");
  const listed = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : "";
  const skills = TICKETING_SKILLS.filter((skill) => new RegExp(`^"?${skill}"?,`, "m").test(listed));
  if (skills.length === TICKETING_SKILLS.length) {
    const version = fs.existsSync(path.join(projectRoot, "_bmad", "_config", "manifest.yaml"))
      ? /^\s*version:\s*(\S+)/m.exec(fs.readFileSync(path.join(projectRoot, "_bmad", "_config", "manifest.yaml"), "utf8"))?.[1] ?? "unknown"
      : "unknown";
    return {
      name: "BMAD ticketing",
      status: "available",
      detail: `BMad ${version} provides ticketing through ${skills.join(" and ")} (${manifest}). This layout ships no tickets.py; BMAD Next renders tickets.toml itself.`,
    };
  }
  return {
    name: "BMAD ticketing",
    status: "not-configured",
    detail: "No upstream ticketing found: neither tickets.py nor the bmad-create-epics-and-stories and bmad-sprint-planning skills are installed.",
  };
}

function roleCheck(name: string, config: BmadRunnerConfig | null, coder: BmadRunnerConfig | null, runner: CommandRunner, missing: string): DoctorCheck {
  if (!config) return { name, status: "not-configured", detail: missing };
  const found = path.isAbsolute(config.command) ? fs.existsSync(config.command) : Boolean(runner.which(config.command));
  if (!found) return { name, status: "not-available", detail: `${config.command} is configured but not on PATH.` };
  const args = config.args ?? [];
  const shared = coder !== null && coder.command === config.command && JSON.stringify(coder.args ?? []) === JSON.stringify(args);
  const model = config.model ?? args[args.indexOf("--model") + 1] ?? "runner default";
  return {
    name,
    status: "available",
    detail: `${config.command} ${args.join(" ")} (model ${model})${shared ? ". Same arguments as the coding runner." : ". Separate from the coding runner."}`,
  };
}

function version(name: string, bin: string, args: string[], runner: CommandRunner): DoctorCheck {
  const found = runner.which(bin);
  if (!found) return { name, status: "not-available", detail: `${bin} is not on PATH.` };
  const result = runner.run(bin, args, process.cwd(), 8000);
  const detail = (result.stdout || result.stderr).trim().split("\n")[0] ?? found;
  return { name, status: result.exitCode === 0 ? "available" : "blocked", detail };
}

function envCheck(name: string, value: string | undefined, missing: string): DoctorCheck {
  const present = (value ?? "").trim().length > 0;
  return { name, status: present ? "configured" : "not-configured", detail: present ? `${name} is configured. A successful call was not made.` : missing };
}

function playwrightCheck(runner: CommandRunner): DoctorCheck {
  const cli = binary("Playwright", "playwright", runner);
  if (cli.status === "available") return cli;
  const probed = probePlaywright();
  if (probed.binaryInstalled) return { name: "Playwright", status: "available", detail: probed.detail };
  if (probed.packageInstalled) return { name: "Playwright", status: "blocked", detail: probed.detail };
  return { name: "Playwright", status: "not-configured", detail: probed.detail };
}

export function doctorLabel(status: DoctorCheck["status"]): "AVAILABLE" | "CONFIGURED" | "NOT_CONFIGURED" | "FAILED" {
  if (status === "available") return "AVAILABLE";
  if (status === "configured") return "CONFIGURED";
  if (status === "blocked") return "FAILED";
  return "NOT_CONFIGURED";
}

const DOCTOR_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: "BMAD", names: ["BMAD memlog", "BMAD ticketing"] },
  { title: "MODEL", names: ["Model runner", "Reviewer runner", "Attacker runner"] },
  { title: "CODING RUNTIME", names: ["OpenCode", "Default runtime", "OpenHands SDK", "Qwen", "Goose", "SWE-agent"] },
  { title: "BROWSER", names: ["Playwright"] },
  { title: "SECURITY", names: ["Semgrep", "Trivy", "TruffleHog"] },
  { title: "NFR", names: ["Node"] },
  { title: "ARCHITECTURE", names: ["Git", "tree-sitter", "ast-grep"] },
  { title: "OBSERVABILITY", names: ["Langfuse", "LiteLLM"] },
];

export function doctorBrief(checks: DoctorCheck[]): string {
  const lines = ["Doctor reports availability. AVAILABLE is not a verification pass."];
  for (const group of DOCTOR_GROUPS) {
    lines.push(group.title);
    for (const name of group.names) {
      const check = checks.find((item) => item.name === name);
      if (!check) continue;
      lines.push(`${name}: ${doctorLabel(check.status)}`);
      if (doctorLabel(check.status) !== "AVAILABLE") lines.push(check.detail);
    }
  }
  return lines.join("\n");
}

function binary(name: string, bin: string, runner: CommandRunner): DoctorCheck {
  const found = runner.which(bin);
  return found
    ? { name, status: "available", detail: found }
    : { name, status: "not-available", detail: `${bin} is not on PATH.` };
}
