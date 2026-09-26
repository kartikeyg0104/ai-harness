import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./model-runner";
import type { CommandRunner, SecurityFinding } from "./types";

export type { SecurityFinding };

export type SecurityStatus = "NOT_CONFIGURED" | "RUNNING" | "PASS" | "FAIL" | "TIMEOUT" | "ERROR";

export interface SecurityContext {
  missionId: string;
  ticketRef: string;
  worktree: string;
  root: string;
}

export interface SecurityToolResult {
  id: string;
  status: SecurityStatus;
  version: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  findings: SecurityFinding[];
  durationMs: number;
  timestamp: string;
  worktree: string;
  scanners: string[];
}

export interface SecurityResult {
  status: SecurityStatus;
  tools: SecurityToolResult[];
  findings: SecurityFinding[];
  worktree: string;
  timestamp: string;
}

export interface SecurityProvider {
  id: string;
  available(): Promise<boolean>;
  scan(context: SecurityContext): Promise<SecurityResult>;
}

export interface SecurityScanner extends SecurityProvider {
  scanBlocking(context: SecurityContext): SecurityResult;
}

const BLOCKING = new Set(["HIGH", "CRITICAL", "ERROR"]);

function semgrepRulesPath(): string {
  return path.resolve(__dirname, "../rules/bmad-semgrep.yml");
}

export function isBlockingFinding(finding: SecurityFinding): boolean {
  return finding.category === "secret" || BLOCKING.has(finding.severity.toUpperCase());
}

export function redactSecurityOutput(text: string): string {
  return redactSecrets(text)
    .replace(/"(Raw|RawV2|Match|Secret|raw)"\s*:\s*"(?:\\.|[^"\\])*"/g, '"$1":"[REDACTED]"')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .slice(0, 8000);
}

export function combineSecurityStatus(tools: SecurityToolResult[]): SecurityStatus {
  if (tools.length === 0 || tools.some((tool) => tool.status === "NOT_CONFIGURED")) return "NOT_CONFIGURED";
  if (tools.some((tool) => tool.status === "TIMEOUT")) return "TIMEOUT";
  if (tools.some((tool) => tool.status === "ERROR")) return "ERROR";
  if (tools.some((tool) => tool.status === "FAIL")) return "FAIL";
  if (tools.every((tool) => tool.status === "PASS")) return "PASS";
  return "ERROR";
}

function severityOf(value: string): string {
  const text = value.toUpperCase();
  if (text === "ERROR" || text === "CRITICAL") return "critical";
  if (text === "HIGH") return "high";
  if (text === "WARNING" || text === "MEDIUM") return "medium";
  return "low";
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseSemgrep(stdout: string, exitCode: number | null, timedOut: boolean): { status: SecurityStatus; findings: SecurityFinding[]; version: string } {
  if (timedOut) return { status: "TIMEOUT", findings: [], version: "" };
  const body = jsonObject(stdout);
  if (!body || !Array.isArray(body.results)) return { status: "ERROR", findings: [], version: "" };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const findings = body.results.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const extra = row.extra && typeof row.extra === "object" ? (row.extra as Record<string, unknown>) : {};
    const startLine = row.start && typeof row.start === "object" ? (row.start as Record<string, unknown>).line : undefined;
    return {
      id: `SEC-${String(index + 1).padStart(3, "0")}`,
      tool: "semgrep",
      severity: severityOf(String(extra.severity ?? "low")),
      category: "sast",
      message: String(extra.message ?? row.check_id ?? "Semgrep finding"),
      path: typeof row.path === "string" ? row.path : undefined,
      line: typeof startLine === "number" ? startLine : undefined,
    };
  });
  const version = typeof body.version === "string" ? body.version : "";
  if (errors.length > 0 && findings.length === 0) return { status: "ERROR", findings: [], version };
  if (exitCode !== 0 && exitCode !== 1 && findings.length === 0) return { status: "ERROR", findings, version };
  if (findings.some(isBlockingFinding)) return { status: "FAIL", findings, version };
  if (exitCode !== 0 && exitCode !== null) return { status: "ERROR", findings, version };
  return { status: "PASS", findings, version };
}

export function parseTrivy(stdout: string, exitCode: number | null, timedOut: boolean, scanners: string[]): { status: SecurityStatus; findings: SecurityFinding[]; version: string } {
  if (timedOut) return { status: "TIMEOUT", findings: [], version: "" };
  const body = jsonObject(stdout);
  if (!body) return { status: "ERROR", findings: [], version: "" };
  const version = body.Trivy && typeof body.Trivy === "object" ? String((body.Trivy as Record<string, unknown>).Version ?? "") : "";
  const results = Array.isArray(body.Results) ? body.Results : [];
  const findings: SecurityFinding[] = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const row = result as Record<string, unknown>;
    const target = typeof row.Target === "string" ? row.Target : undefined;
    for (const vuln of Array.isArray(row.Vulnerabilities) ? row.Vulnerabilities : []) {
      if (!vuln || typeof vuln !== "object") continue;
      const item = vuln as Record<string, unknown>;
      findings.push({
        id: `SEC-${String(findings.length + 1).padStart(3, "0")}`,
        tool: "trivy",
        severity: severityOf(String(item.Severity ?? "low")),
        category: "vulnerability",
        message: `${String(item.VulnerabilityID ?? "vulnerability")} ${String(item.Title ?? item.PkgName ?? "")}`.trim(),
        path: target,
      });
    }
    for (const misconfig of Array.isArray(row.Misconfigurations) ? row.Misconfigurations : []) {
      if (!misconfig || typeof misconfig !== "object") continue;
      const item = misconfig as Record<string, unknown>;
      const cause = item.CauseMetadata && typeof item.CauseMetadata === "object" ? (item.CauseMetadata as Record<string, unknown>) : {};
      findings.push({
        id: `SEC-${String(findings.length + 1).padStart(3, "0")}`,
        tool: "trivy",
        severity: severityOf(String(item.Severity ?? "low")),
        category: "misconfiguration",
        message: `${String(item.ID ?? "misconfig")} ${String(item.Title ?? item.Message ?? "")}`.trim(),
        path: target,
        line: typeof cause.StartLine === "number" ? cause.StartLine : undefined,
      });
    }
    for (const secret of Array.isArray(row.Secrets) ? row.Secrets : []) {
      if (!secret || typeof secret !== "object") continue;
      const item = secret as Record<string, unknown>;
      findings.push({
        id: `SEC-${String(findings.length + 1).padStart(3, "0")}`,
        tool: "trivy",
        severity: "critical",
        category: "secret",
        message: `${String(item.RuleID ?? item.Category ?? "secret")} ${String(item.Title ?? "secret detected")}`.trim(),
        path: target,
        line: typeof item.StartLine === "number" ? item.StartLine : undefined,
        evidence: "[REDACTED]",
      });
    }
  }
  if (exitCode !== 0 && exitCode !== null && findings.length === 0) return { status: "ERROR", findings, version };
  if (findings.some(isBlockingFinding)) return { status: "FAIL", findings, version };
  if (scanners.length === 0) return { status: "ERROR", findings, version };
  return { status: "PASS", findings, version };
}

export function parseTrufflehog(stdout: string, exitCode: number | null, timedOut: boolean): { status: SecurityStatus; findings: SecurityFinding[]; version: string } {
  if (timedOut) return { status: "TIMEOUT", findings: [], version: "" };
  const findings: SecurityFinding[] = [];
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") return { status: "ERROR", findings: [], version: "" };
      row = parsed as Record<string, unknown>;
    } catch {
      return { status: "ERROR", findings: [], version: "" };
    }
    if (typeof row.DetectorName !== "string") continue;
    const metadata = row.SourceMetadata && typeof row.SourceMetadata === "object" ? (row.SourceMetadata as Record<string, unknown>) : {};
    const data = metadata.Data && typeof metadata.Data === "object" ? (metadata.Data as Record<string, unknown>) : {};
    const filesystem = data.Filesystem && typeof data.Filesystem === "object" ? (data.Filesystem as Record<string, unknown>) : {};
    findings.push({
      id: `SEC-${String(findings.length + 1).padStart(3, "0")}`,
      tool: "trufflehog",
      severity: "critical",
      category: "secret",
      message: `TruffleHog detected a ${row.DetectorName} secret`,
      path: typeof filesystem.file === "string" ? filesystem.file : undefined,
      line: typeof filesystem.line === "number" ? filesystem.line : undefined,
      evidence: "[REDACTED]",
    });
  }
  if (exitCode !== 0 && exitCode !== null && findings.length === 0) return { status: "ERROR", findings, version: "" };
  if (findings.length > 0) return { status: "FAIL", findings, version: "" };
  return { status: "PASS", findings, version: "" };
}

function renumber(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.map((finding, index) => ({ ...finding, id: `SEC-${String(index + 1).padStart(3, "0")}` }));
}

export class CommandSecurityScanner implements SecurityScanner {
  readonly id = "command-security";

  constructor(
    private readonly runner: CommandRunner,
    private readonly timeoutMs = 120000,
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(Boolean(this.runner.which("semgrep") || this.runner.which("trivy") || this.runner.which("trufflehog")));
  }

  scan(context: SecurityContext): Promise<SecurityResult> {
    return Promise.resolve(this.scanBlocking(context));
  }

  scanBlocking(context: SecurityContext): SecurityResult {
    const tools = [this.semgrep(context), this.trivy(context), this.trufflehog(context)];
    const findings = renumber(tools.flatMap((tool) => tool.findings));
    return {
      status: combineSecurityStatus(tools),
      tools,
      findings,
      worktree: context.worktree,
      timestamp: new Date().toISOString(),
    };
  }

  private semgrep(context: SecurityContext): SecurityToolResult {
    return this.execute("semgrep", context, () => {
      const rulesPath = semgrepRulesPath();
      if (!fs.existsSync(rulesPath)) {
        return {
          args: ["scan", "--config", rulesPath, context.worktree],
          result: { exitCode: 1, stdout: "", stderr: "Semgrep rules file is missing.", durationMs: 0, timedOut: false },
          parsed: { status: "ERROR" as const, findings: [], version: "" },
          scanners: [],
        };
      }
      const args = ["scan", "--metrics=off", "--disable-version-check", "--no-git-ignore", "--quiet", "--json", "--exclude", "node_modules", "--exclude", ".git", "--config", rulesPath, context.worktree];
      const result = this.runner.run("semgrep", args, context.worktree, this.timeoutMs, { SEMGREP_SEND_METRICS: "off" });
      const parsed = parseSemgrep(result.stdout, result.exitCode, result.timedOut);
      return { args, result, parsed, scanners: ["sast"] };
    });
  }

  private trivy(context: SecurityContext): SecurityToolResult {
    return this.execute("trivy", context, () => {
      const requested = ["vuln", "misconfig", "secret"];
      const args = ["fs", "--format", "json", "--scanners", requested.join(","), "--quiet", "--exit-code", "0", "--skip-dirs", "node_modules", "--skip-dirs", ".git", context.worktree];
      const result = this.runner.run("trivy", args, context.worktree, this.timeoutMs);
      if (!result.timedOut && jsonObject(result.stdout)) {
        const parsed = parseTrivy(result.stdout, result.exitCode, result.timedOut, requested);
        return { args, result, parsed, scanners: requested };
      }
      const scanners: string[] = [];
      const chunks: string[] = [];
      const errors: string[] = [];
      let exitCode = result.exitCode;
      let timedOut = result.timedOut;
      let duration = result.durationMs;
      for (const mode of requested) {
        const modeArgs = ["fs", "--format", "json", "--scanners", mode, "--quiet", "--exit-code", "0", "--skip-dirs", "node_modules", context.worktree];
        const modeResult = this.runner.run("trivy", modeArgs, context.worktree, this.timeoutMs);
        duration += modeResult.durationMs;
        chunks.push(modeResult.stdout);
        if (modeResult.timedOut) timedOut = true;
        if (jsonObject(modeResult.stdout)) scanners.push(mode);
        else errors.push(modeResult.stderr);
        if (modeResult.exitCode !== 0) exitCode = modeResult.exitCode;
      }
      const parsed = parseTrivy(chunks.join("\n"), timedOut ? null : exitCode, timedOut, scanners);
      if (scanners.length !== requested.length && parsed.status === "PASS") parsed.status = "ERROR";
      if (errors.length > 0 && scanners.length === 0) parsed.status = timedOut ? "TIMEOUT" : "ERROR";
      return { args, result: { ...result, stdout: chunks.join("\n"), stderr: errors.join("\n"), durationMs: duration, timedOut, exitCode }, parsed, scanners };
    });
  }

  private trufflehog(context: SecurityContext): SecurityToolResult {
    return this.execute("trufflehog", context, () => {
      const args = ["filesystem", context.worktree, "--json", "--no-verification", "--no-update"];
      const result = this.runner.run("trufflehog", args, context.worktree, this.timeoutMs);
      const parsed = parseTrufflehog(result.stdout, result.exitCode, result.timedOut);
      if (!parsed.version) {
        const version = this.runner.run("trufflehog", ["--version"], context.worktree, 10000);
        if (version.exitCode === 0) parsed.version = version.stdout.trim().split("\n")[0]?.slice(0, 120) ?? "";
      }
      return { args, result, parsed, scanners: ["filesystem"] };
    });
  }

  private execute(
    tool: string,
    context: SecurityContext,
    run: () => {
      args: string[];
      result: { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean };
      parsed: { status: SecurityStatus; findings: SecurityFinding[]; version: string };
      scanners: string[];
    },
  ): SecurityToolResult {
    const timestamp = new Date().toISOString();
    if (!this.runner.which(tool)) {
      return {
        id: tool,
        status: "NOT_CONFIGURED",
        version: "",
        command: tool,
        exitCode: null,
        stdout: "",
        stderr: "",
        findings: [],
        durationMs: 0,
        timestamp,
        worktree: context.worktree,
        scanners: [],
      };
    }
    const executed = run();
    const command = [tool, ...executed.args].join(" ");
    return {
      id: tool,
      status: executed.parsed.status,
      version: executed.parsed.version,
      command,
      exitCode: executed.result.exitCode,
      stdout: redactSecurityOutput(executed.result.stdout),
      stderr: redactSecurityOutput(executed.result.stderr),
      findings: executed.parsed.findings.map((finding) => ({ ...finding, evidence: finding.category === "secret" ? "[REDACTED]" : finding.evidence })),
      durationMs: executed.result.durationMs,
      timestamp,
      worktree: context.worktree,
      scanners: executed.parsed.status === "NOT_CONFIGURED" ? [] : executed.scanners,
    };
  }
}

type SecurityScript = "unavailable" | "timeout" | "nonzero" | "malformed" | "secret" | "high" | "critical" | "clean";

export class DeterministicSecurity implements SecurityScanner {
  readonly id = "deterministic-test-security";
  private index = 0;

  constructor(
    private readonly script: SecurityScript[],
    private readonly secret = "sk-live-supersecretvalue",
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(this.mode() !== "unavailable");
  }

  scan(context: SecurityContext): Promise<SecurityResult> {
    return Promise.resolve(this.scanBlocking(context));
  }

  scanBlocking(context: SecurityContext): SecurityResult {
    const mode = this.mode();
    this.index += 1;
    const timestamp = new Date().toISOString();
    if (mode === "unavailable") {
      const tools = ["semgrep", "trivy", "trufflehog"].map((id) => this.tool(id, "NOT_CONFIGURED", context, timestamp, [], null));
      return { status: "NOT_CONFIGURED", tools, findings: [], worktree: context.worktree, timestamp };
    }
    const finding = (severity: string, category: string, message: string): SecurityFinding => ({
      id: "SEC-001",
      tool: "semgrep",
      severity,
      category,
      message,
      path: "src/health.js",
      line: 1,
      evidence: category === "secret" ? "[REDACTED]" : message,
    });
    let status: SecurityStatus = "PASS";
    let findings: SecurityFinding[] = [];
    let stdout = '{"results":[]}';
    let exitCode: number | null = 0;
    if (mode === "timeout") {
      status = "TIMEOUT";
      exitCode = null;
      stdout = "";
    } else if (mode === "nonzero") {
      status = "ERROR";
      exitCode = 2;
      stdout = '{"results":[]}';
    } else if (mode === "malformed") {
      status = "ERROR";
      exitCode = 1;
      stdout = "{";
    } else if (mode === "secret") {
      status = "FAIL";
      exitCode = 1;
      findings = [finding("critical", "secret", "Secret detected")];
      stdout = redactSecurityOutput(`{"Raw":"${this.secret}"}`);
    } else if (mode === "high") {
      status = "FAIL";
      exitCode = 1;
      findings = [finding("high", "sast", "High severity finding")];
    } else if (mode === "critical") {
      status = "FAIL";
      exitCode = 1;
      findings = [finding("critical", "sast", "Critical severity finding")];
    }
    const tools = [
      this.tool("semgrep", status, context, timestamp, findings, exitCode, stdout),
      this.tool("trivy", status === "PASS" ? "PASS" : status, context, timestamp, [], status === "PASS" ? 0 : exitCode),
      this.tool("trufflehog", status === "PASS" ? "PASS" : status, context, timestamp, mode === "secret" ? findings : [], status === "PASS" ? 0 : exitCode),
    ];
    if (mode === "high" || mode === "critical" || mode === "malformed" || mode === "nonzero" || mode === "timeout") {
      tools[1] = this.tool("trivy", "PASS", context, timestamp, [], 0);
      tools[2] = this.tool("trufflehog", "PASS", context, timestamp, [], 0);
    }
    return { status: combineSecurityStatus(tools), tools, findings, worktree: context.worktree, timestamp };
  }

  private mode(): SecurityScript {
    return this.script[Math.min(this.index, Math.max(this.script.length - 1, 0))] ?? "malformed";
  }

  private tool(id: string, status: SecurityStatus, context: SecurityContext, timestamp: string, findings: SecurityFinding[], exitCode: number | null, stdout = ""): SecurityToolResult {
    const scanners = status === "NOT_CONFIGURED" ? [] : id === "trivy" ? ["vuln", "misconfig", "secret"] : id === "trufflehog" ? ["filesystem"] : ["sast"];
    return {
      id,
      status,
      version: status === "NOT_CONFIGURED" ? "" : "test",
      command: status === "NOT_CONFIGURED" ? id : `${id} scan ${context.worktree}`,
      exitCode,
      stdout,
      stderr: "",
      findings: findings.filter((finding) => finding.tool === id || id === "semgrep"),
      durationMs: status === "TIMEOUT" ? 1000 : 5,
      timestamp,
      worktree: context.worktree,
      scanners,
    };
  }
}
