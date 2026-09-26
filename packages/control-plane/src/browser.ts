import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { executeBrowserScenario } from "./browser-runner";
import { nodeProcess } from "./node-process";
import { decideCommand } from "./policy";
import type { Autonomy } from "./types";

export type BrowserRunStatus = "NOT_CONFIGURED" | "AVAILABLE" | "STARTING" | "RUNNING" | "PASS" | "FAIL" | "TIMEOUT" | "ERROR";

export interface BrowserStep {
  action: "navigate" | "click" | "fill" | "select" | "wait" | "screenshot";
  target?: string;
  value?: string;
  name?: string;
}

export interface BrowserAssertion {
  kind: "visible" | "text" | "url" | "attribute" | "count";
  target: string;
  expected: string;
  attribute?: string;
}

export interface BrowserScenario {
  id: string;
  requirementId: string;
  name: string;
  startUrl: string;
  steps: BrowserStep[];
  assertions: BrowserAssertion[];
}

export interface BrowserReadiness {
  packageInstalled: boolean;
  binaryInstalled: boolean;
  launched: boolean;
  executed: boolean;
  passed: boolean;
}

export interface BrowserResult {
  status: BrowserRunStatus;
  summary: string;
  readiness: BrowserReadiness;
  scenarioId: string;
  requirementId: string;
  browser: string;
  browserVersion: string | null;
  url: string;
  viewport: { width: number; height: number };
  steps: Array<{ action: string; name: string; status: string; at: string }>;
  assertions: Array<{ kind: string; target: string; expected: string; status: "PASS" | "FAIL"; message: string }>;
  screenshots: Array<{ name: string; path: string }>;
  consoleLogs: string[];
  networkErrors: string[];
  startedAt: string;
  endedAt: string;
}

export interface BrowserRunOptions {
  origins?: string[];
  autonomy?: Autonomy;
  timeoutMs?: number;
  evidenceDir?: string;
}

export interface BrowserProvider {
  id: string;
  available(): Promise<boolean>;
  availableSync(): boolean;
  run(scenario: BrowserScenario, options?: BrowserRunOptions): Promise<BrowserResult>;
  runSync(scenario: BrowserScenario, options?: BrowserRunOptions): BrowserResult;
}

const VIEWPORT = { width: 1280, height: 720 };
const ACTIONS = new Set(["navigate", "click", "fill", "select", "wait", "screenshot"]);
const ASSERTIONS = new Set(["visible", "text", "url", "attribute", "count"]);

export function browserNavigationAllowed(url: string, origins: string[], autonomy: Autonomy): { allowed: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "Browser URL is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "Browser URL must be http or https." };
  }
  const allowedHost = origins.some((origin) => {
    try {
      const candidate = new URL(origin.includes("://") ? origin : `http://${origin}`);
      return candidate.protocol === parsed.protocol && candidate.hostname === parsed.hostname;
    } catch {
      return false;
    }
  });
  if (!allowedHost) return { allowed: false, reason: `Browser origin ${parsed.origin} is outside the configured allowed origins.` };
  const decision = decideCommand(`playwright navigate ${url}`, autonomy);
  if (decision.decision !== "allow") return { allowed: false, reason: `Browser navigation was not allowed: ${decision.rule}.` };
  return { allowed: true, reason: decision.rule };
}

export function scenarioFromCriterion(requirementId: string, criterion: string, startUrl: string): BrowserScenario | null {
  const text = criterion.trim();
  if (!requirementId.trim() || !text || !startUrl.trim()) return null;
  const steps: BrowserStep[] = [{ action: "navigate", target: startUrl, name: "open" }];
  if (/\b(add|create)\s+an?\s+expense\b/i.test(text)) {
    steps.push({ action: "click", target: "text=Add Expense", name: "add-expense" });
    steps.push({ action: "fill", target: "input[name=amount]", value: "12.00", name: "amount" });
    steps.push({ action: "click", target: "text=Save", name: "save" });
  }
  const assertions: BrowserAssertion[] = [];
  for (const match of text.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const expected = match[1] ?? match[2];
    if (expected) assertions.push({ kind: "text", target: "body", expected });
  }
  if (/\b(add|create)\s+an?\s+expense\b/i.test(text)) assertions.push({ kind: "text", target: "body", expected: "12.00" });
  if (assertions.length === 0) return null;
  return {
    id: `BROWSER-${requirementId}`,
    requirementId,
    name: text.slice(0, 80),
    startUrl,
    steps,
    assertions,
  };
}

export function validateScenario(scenario: BrowserScenario, origins: string[], autonomy: Autonomy): string | null {
  if (!scenario.id.trim() || !scenario.requirementId.trim() || !scenario.name.trim()) return "Browser scenario is missing its id, requirement, or name.";
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) return "Browser scenario has no steps.";
  if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) return "Browser scenario has no assertions.";
  for (const step of scenario.steps) {
    if (!ACTIONS.has(step.action)) return `Browser step ${step.action} is not supported.`;
  }
  for (const assertion of scenario.assertions) {
    if (!ASSERTIONS.has(assertion.kind) || !assertion.target.trim()) return "Browser assertion is invalid.";
  }
  const urls = [scenario.startUrl, ...scenario.steps.filter((step) => step.action === "navigate").map((step) => step.target ?? "")];
  for (const url of urls) {
    const allowed = browserNavigationAllowed(url, origins, autonomy);
    if (!allowed.allowed) return allowed.reason;
  }
  return null;
}

export function probePlaywright(): BrowserReadiness & { browserVersion: string | null; detail: string } {
  const empty = { packageInstalled: false, binaryInstalled: false, launched: false, executed: false, passed: false, browserVersion: null, detail: "Playwright is not installed." };
  const node = nodeProcess();
  const probe = spawnSync(node.command, ["-e", PLAYWRIGHT_PROBE], {
    cwd: packageRoot(),
    encoding: "utf8",
    timeout: 20000,
    env: node.env,
  });
  if (probe.error || probe.status !== 0) {
    return { ...empty, detail: (probe.stderr || probe.stdout || probe.error?.message || empty.detail).trim() };
  }
  try {
    const parsed = JSON.parse(probe.stdout) as { packageInstalled?: boolean; binaryInstalled?: boolean; browserVersion?: string | null; detail?: string };
    return {
      packageInstalled: parsed.packageInstalled === true,
      binaryInstalled: parsed.binaryInstalled === true,
      launched: false,
      executed: false,
      passed: false,
      browserVersion: parsed.browserVersion ?? null,
      detail: parsed.detail ?? "Playwright probe finished.",
    };
  } catch {
    return { ...empty, detail: "Playwright probe did not return JSON." };
  }
}

export class PlaywrightBrowser implements BrowserProvider {
  readonly id = "playwright";

  available(): Promise<boolean> {
    return Promise.resolve(this.availableSync());
  }

  availableSync(): boolean {
    const probe = probePlaywright();
    return probe.packageInstalled && probe.binaryInstalled;
  }

  run(scenario: BrowserScenario, options: BrowserRunOptions = {}): Promise<BrowserResult> {
    return this.execute(scenario, options);
  }

  runSync(scenario: BrowserScenario, options: BrowserRunOptions = {}): BrowserResult {
    throw new Error(`Playwright scenario ${scenario.id} must run asynchronously. ${options.evidenceDir ?? ""}`.trim());
  }

  private async execute(scenario: BrowserScenario, options: BrowserRunOptions): Promise<BrowserResult> {
    const startedAt = new Date().toISOString();
    const origins = options.origins ?? ["http://127.0.0.1", "http://localhost"];
    const autonomy = options.autonomy ?? "assist";
    const probe = probePlaywright();
    const base = emptyResult(scenario, startedAt, probe);
    if (!probe.packageInstalled || !probe.binaryInstalled) {
      return { ...base, status: "NOT_CONFIGURED", summary: probe.detail, readiness: probe };
    }
    const invalid = validateScenario(scenario, origins, autonomy);
    if (invalid) return { ...base, status: "ERROR", summary: invalid, readiness: { ...probe, packageInstalled: true, binaryInstalled: true } };
    const evidenceDir = options.evidenceDir ?? fs.mkdtempSync(path.join(packageRoot(), ".browser-evidence-"));
    fs.mkdirSync(evidenceDir, { recursive: true });
    const timeoutMs = options.timeoutMs ?? 30000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const executed = await Promise.race([
      executeBrowserScenario({ scenario, evidenceDir, timeoutMs, viewport: VIEWPORT }, startedAt),
      new Promise<BrowserResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            ...base,
            status: "TIMEOUT",
            summary: "Browser timed out. Partial screenshots are not a pass.",
            endedAt: new Date().toISOString(),
            readiness: { ...probe, launched: true, executed: false, passed: false },
          });
        }, timeoutMs + 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return seal(executed);
  }
}

/** Test-only browser. The production plane does not construct it. */
export class DeterministicBrowser implements BrowserProvider {
  readonly id = "deterministic-test-browser";
  calls = 0;

  constructor(private readonly mode: "unavailable" | "launch-error" | "timeout" | "assertion-fail" | "invalid" | "pass") {}

  available(): Promise<boolean> {
    return Promise.resolve(this.availableSync());
  }

  availableSync(): boolean {
    return this.mode !== "unavailable";
  }

  run(scenario: BrowserScenario, options?: BrowserRunOptions): Promise<BrowserResult> {
    return Promise.resolve(this.runSync(scenario, options));
  }

  runSync(scenario: BrowserScenario, _options?: BrowserRunOptions): BrowserResult {
    this.calls += 1;
    const startedAt = new Date().toISOString();
    const readiness: BrowserReadiness = {
      packageInstalled: this.mode !== "unavailable",
      binaryInstalled: this.mode !== "unavailable",
      launched: false,
      executed: false,
      passed: false,
    };
    const base = emptyResult(scenario, startedAt, readiness);
    if (this.mode === "unavailable") return { ...base, status: "NOT_CONFIGURED", summary: "Playwright is not configured." };
    if (this.mode === "invalid") return { ...base, status: "ERROR", summary: "Browser scenario is invalid." };
    if (this.mode === "launch-error") return { ...base, status: "ERROR", summary: "Browser launch failed." };
    if (this.mode === "timeout") {
      return { ...base, status: "TIMEOUT", summary: "Browser timed out. Partial screenshots are not a pass.", readiness: { ...readiness, launched: true } };
    }
    if (this.mode === "assertion-fail") {
      return {
        ...base,
        status: "FAIL",
        summary: "Expected text was not found.",
        readiness: { ...readiness, launched: true, executed: true },
        assertions: scenario.assertions.map((assertion) => ({ ...assertion, status: "FAIL" as const, message: "not found" })),
      };
    }
    return {
      ...base,
      status: "PASS",
      summary: "Deterministic browser passed. This provider is test-only.",
      readiness: { ...readiness, launched: true, executed: true, passed: true },
      screenshots: [],
      assertions: scenario.assertions.map((assertion) => ({ ...assertion, status: "PASS" as const, message: "test-only" })),
    };
  }
}

export function seal(result: BrowserResult): BrowserResult {
  if (result.status !== "PASS") {
    result.readiness.passed = false;
    return result;
  }
  const shots = result.screenshots.filter((shot) => shot.path && fs.existsSync(shot.path));
  const incomplete = shots.length === 0 || result.assertions.some((assertion) => assertion.status !== "PASS") || !result.readiness.launched || !result.readiness.executed;
  if (incomplete) {
    return {
      ...result,
      status: "FAIL",
      summary: shots.length === 0 ? "Browser PASS was rejected because no screenshot file exists." : "Browser PASS was rejected because execution evidence is incomplete.",
      readiness: { ...result.readiness, passed: false },
    };
  }
  result.screenshots = shots;
  result.readiness.passed = true;
  return result;
}

function emptyResult(scenario: BrowserScenario, startedAt: string, readiness: BrowserReadiness): BrowserResult {
  return {
    status: "ERROR",
    summary: "",
    readiness,
    scenarioId: scenario.id,
    requirementId: scenario.requirementId,
    browser: "chromium",
    browserVersion: null,
    url: scenario.startUrl,
    viewport: VIEWPORT,
    steps: [],
    assertions: [],
    screenshots: [],
    consoleLogs: [],
    networkErrors: [],
    startedAt,
    endedAt: startedAt,
  };
}

function packageRoot(): string {
  return path.resolve(__dirname, "..");
}

function readRunnerResult(evidenceDir: string): BrowserResult | null {
  const file = path.join(evidenceDir, "result.json");
  if (!fs.existsSync(file)) return null;
  return parseStdout(fs.readFileSync(file, "utf8"));
}

function parseStdout(raw: string): BrowserResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as BrowserResult;
    if (!parsed || typeof parsed !== "object" || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

const PLAYWRIGHT_PROBE = `
try {
  const { chromium } = require("playwright");
  const executablePath = chromium.executablePath();
  const fs = require("fs");
  const binaryInstalled = fs.existsSync(executablePath);
  process.stdout.write(JSON.stringify({
    packageInstalled: true,
    binaryInstalled,
    browserVersion: null,
    detail: binaryInstalled ? "Playwright package and browser binary are installed. Installation is not verification." : "Playwright package is installed. The browser binary is not installed."
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ packageInstalled: false, binaryInstalled: false, detail: error instanceof Error ? error.message : String(error) }));
}
`;
