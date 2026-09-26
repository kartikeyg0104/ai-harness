import type { CommandRunner, NfrRequirement } from "./types";

export interface NfrContext {
  missionId: string;
  ticketRef: string;
  worktree: string;
  requirement: NfrRequirement;
}

export interface NfrMeasurement {
  id: string;
  metric: string;
  measured: number | null;
  target: number;
  operator: NfrRequirement["operator"];
  unit: string;
  result: "PASS" | "FAIL" | "NOT_RUN" | "ERROR" | "NOT_CONFIGURED";
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface NfrResult {
  status: "NOT_CONFIGURED" | "PASS" | "FAIL" | "ERROR" | "NOT_RUN";
  measurements: NfrMeasurement[];
  runtime: string;
  environment: string;
  timestamp: string;
}

export interface NfrProvider {
  id: string;
  available(): Promise<boolean>;
  measure(context: NfrContext): Promise<NfrMeasurement>;
}

export interface NfrScanner extends NfrProvider {
  measureBlocking(context: NfrContext): NfrMeasurement;
}

export function nfrFromText(text: string, idPrefix = "NFR"): NfrRequirement[] {
  const found: NfrRequirement[] = [];
  const pattern = /\b(p95 latency|latency|memory|startup|throughput)\s*(<=|>=|==|<|>)\s*(\d+(?:\.\d+)?)\s*(ms|s|mb|gb|rps)\b/gi;
  let match: RegExpExecArray | null;
  let index = 1;
  while ((match = pattern.exec(text))) {
    const metric = match[1].toLowerCase();
    const category = metric === "memory" ? "resource" : metric === "throughput" ? "scalability" : "performance";
    found.push({
      id: `${idPrefix}-${String(index).padStart(3, "0")}`,
      category,
      metric: match[1],
      operator: match[2] as NfrRequirement["operator"],
      target: Number(match[3]),
      unit: match[4].toLowerCase(),
      verificationMethod: "",
    });
    index += 1;
  }
  return found;
}

export function compareMeasurement(measured: number, operator: NfrRequirement["operator"], target: number): boolean {
  if (operator === "<") return measured < target;
  if (operator === "<=") return measured <= target;
  if (operator === ">") return measured > target;
  if (operator === ">=") return measured >= target;
  return measured === target;
}

export function splitCommand(input: string): { command: string; args: string[] } | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) return null;
      return { command: parsed[0] as string, args: parsed.slice(1) as string[] };
    } catch {
      return null;
    }
  }
  const parts = text.split(/\s+/);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

export function readMeasurement(stdout: string): number | null {
  const match = stdout.match(/BMAD-NFR-VALUE:\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export class CommandNfrProvider implements NfrScanner {
  readonly id = "command-nfr";

  constructor(
    private readonly runner: CommandRunner,
    private readonly timeoutMs = 30000,
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(Boolean(this.runner.which("node")));
  }

  measure(context: NfrContext): Promise<NfrMeasurement> {
    return Promise.resolve(this.measureBlocking(context));
  }

  measureBlocking(context: NfrContext): NfrMeasurement {
    const requirement = context.requirement;
    const base = {
      id: requirement.id,
      metric: requirement.metric,
      target: requirement.target,
      operator: requirement.operator,
      unit: requirement.unit,
      measured: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      command: requirement.verificationMethod,
    };
    const split = splitCommand(requirement.verificationMethod);
    if (!split) {
      return { ...base, result: "ERROR", stderr: "The NFR verification method is not declared." };
    }
    if (!this.runner.which(split.command)) {
      return { ...base, result: "NOT_CONFIGURED", command: split.command, stderr: `${split.command} is not installed.` };
    }
    const result = this.runner.run(split.command, split.args, context.worktree, this.timeoutMs);
    const measured = readMeasurement(result.stdout);
    if (result.timedOut || result.exitCode !== 0 || measured === null) {
      return {
        ...base,
        result: "ERROR",
        command: [split.command, ...split.args].join(" "),
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000) || (measured === null ? "The process did not print BMAD-NFR-VALUE." : ""),
        durationMs: result.durationMs,
        measured,
      };
    }
    const passed = compareMeasurement(measured, requirement.operator, requirement.target);
    return {
      ...base,
      result: passed ? "PASS" : "FAIL",
      measured,
      command: [split.command, ...split.args].join(" "),
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      durationMs: result.durationMs,
    };
  }
}

type NfrScript = "unavailable" | "pass" | "fail" | "missing";

export class DeterministicNfr implements NfrScanner {
  readonly id = "deterministic-test-nfr";
  private index = 0;

  constructor(private readonly script: NfrScript[]) {}

  available(): Promise<boolean> {
    return Promise.resolve(this.script[0] !== "unavailable");
  }

  measure(context: NfrContext): Promise<NfrMeasurement> {
    return Promise.resolve(this.measureBlocking(context));
  }

  measureBlocking(context: NfrContext): NfrMeasurement {
    const mode = this.script[Math.min(this.index, Math.max(this.script.length - 1, 0))] ?? "missing";
    this.index += 1;
    const requirement = context.requirement;
    if (mode === "unavailable") {
      return {
        id: requirement.id,
        metric: requirement.metric,
        measured: null,
        target: requirement.target,
        operator: requirement.operator,
        unit: requirement.unit,
        result: "NOT_CONFIGURED",
        command: requirement.verificationMethod,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }
    if (mode === "missing") {
      return {
        id: requirement.id,
        metric: requirement.metric,
        measured: null,
        target: requirement.target,
        operator: requirement.operator,
        unit: requirement.unit,
        result: "ERROR",
        command: requirement.verificationMethod,
        stdout: "",
        stderr: "measurement marker missing",
        durationMs: 1,
      };
    }
    const measured = mode === "pass" ? requirement.target - (requirement.operator.startsWith("<") ? 1 : 0) + (requirement.operator.startsWith(">") ? 1 : 0) : requirement.target + (requirement.operator.startsWith("<") ? 1 : -1);
    const value = mode === "pass" && requirement.operator === "==" ? requirement.target : measured;
    return {
      id: requirement.id,
      metric: requirement.metric,
      measured: value,
      target: requirement.target,
      operator: requirement.operator,
      unit: requirement.unit,
      result: compareMeasurement(value, requirement.operator, requirement.target) ? "PASS" : "FAIL",
      command: requirement.verificationMethod || "deterministic-measure",
      stdout: `BMAD-NFR-VALUE: ${value}`,
      stderr: "",
      durationMs: 1,
    };
  }
}
