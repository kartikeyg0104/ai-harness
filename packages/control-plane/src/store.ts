import fs from "node:fs";
import path from "node:path";
import type { ControlConfig, DomainEvent, Mission } from "./types";
import { DEFAULT_CONFIG } from "./types";

export interface StoreLayout {
  root: string;
  home: string;
}

export function layout(projectRoot: string): StoreLayout {
  return { root: projectRoot, home: path.join(projectRoot, ".bmad-next") };
}

export function ensureHome(projectRoot: string): StoreLayout {
  const paths = layout(projectRoot);
  fs.mkdirSync(path.join(paths.home, "missions"), { recursive: true });
  fs.mkdirSync(path.join(paths.home, "sandboxes"), { recursive: true });
  const configPath = path.join(paths.home, "config.json");
  if (!fs.existsSync(configPath)) {
    writeJson(configPath, DEFAULT_CONFIG);
  }
  return paths;
}

export function readConfig(projectRoot: string): ControlConfig {
  const paths = ensureHome(projectRoot);
  const raw = readJson<Partial<ControlConfig>>(path.join(paths.home, "config.json"));
  return { ...DEFAULT_CONFIG, ...raw, models: { ...DEFAULT_CONFIG.models, ...raw.models } };
}

export function writeConfig(projectRoot: string, config: ControlConfig): void {
  const paths = ensureHome(projectRoot);
  writeJson(path.join(paths.home, "config.json"), config);
}

export function missionDir(projectRoot: string, missionId: string): string {
  return path.join(ensureHome(projectRoot).home, "missions", missionId);
}

const SAVE_LOCK_STALE_MS = 60_000;
const AUTOPILOT_LOCK_STALE_MS = 4 * 60 * 60 * 1000;

export function saveMission(projectRoot: string, mission: Mission): void {
  const dir = missionDir(projectRoot, mission.id);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const file = path.join(dir, "mission.json");
  withExclusiveLock(path.join(dir, "mission.json.lock"), SAVE_LOCK_STALE_MS, () => {
    const merged = fs.existsSync(file) ? mergeMissionRecords(readJson<Mission>(file), mission) : mission;
    writeJson(file, merged);
  });
  fs.writeFileSync(path.join(ensureHome(projectRoot).home, "active-mission"), mission.id);
}

/** Keeps every uniquely-keyed record from both views so a stale in-memory save cannot drop later evidence. */
export function mergeMissionRecords(disk: Mission, incoming: Mission): Mission {
  const incomingNewer = Date.parse(incoming.updatedAt ?? "") >= Date.parse(disk.updatedAt ?? "");
  const base = incomingNewer ? incoming : disk;
  const other = incomingNewer ? disk : incoming;
  return {
    ...other,
    ...base,
    ticketTreeAccepted: Boolean(disk.ticketTreeAccepted || incoming.ticketTreeAccepted),
    lastVerifiedBuild: incoming.lastVerifiedBuild ?? disk.lastVerifiedBuild,
    attempts: mergeAttempts(disk.attempts, incoming.attempts),
    workflow: mergeWorkflow(disk.workflow ?? [], incoming.workflow ?? []),
    plans: mergePlans(disk.plans ?? [], incoming.plans ?? []),
    evidence: unionBy(disk.evidence ?? [], incoming.evidence ?? [], (item) => item.evidence_id),
    artifacts: unionBy(disk.artifacts ?? [], incoming.artifacts ?? [], (item) => item.id),
    reviews: unionBy(disk.reviews ?? [], incoming.reviews ?? [], (item) => [item.ticketRef, item.startedAt, item.attempt, item.status, item.evidencePath].join("|"), preferReview),
    attacks: unionBy(disk.attacks ?? [], incoming.attacks ?? [], (item) => [item.ticketRef, item.startedAt, item.attempt, item.status, item.evidencePath].join("|")),
    repairs: unionBy(disk.repairs ?? [], incoming.repairs ?? [], (item) => [item.ticketRef, item.startedAt, item.attempt, item.status].join("|")),
    findings: unionBy(disk.findings ?? [], incoming.findings ?? [], (item) => item.id),
    usage: unionBy(disk.usage ?? [], incoming.usage ?? [], (item) => item.id),
    dispatches: unionBy(disk.dispatches ?? [], incoming.dispatches ?? [], (item) => item.id),
    approvals: unionBy(disk.approvals ?? [], incoming.approvals ?? [], (item) => item.id),
    executions: mergeExecutions(disk.executions ?? [], incoming.executions ?? []),
    securityRuns: unionBy(disk.securityRuns ?? [], incoming.securityRuns ?? [], (item) => item.id),
    nfrRuns: unionBy(disk.nfrRuns ?? [], incoming.nfrRuns ?? [], (item) => item.id),
    nfrRequirements: unionBy(disk.nfrRequirements ?? [], incoming.nfrRequirements ?? [], (item) => item.id),
    requiredEvidence: unique([...(disk.requiredEvidence ?? []), ...(incoming.requiredEvidence ?? [])]),
  };
}

export function acquireAutopilotLock(projectRoot: string, missionId: string): boolean {
  const file = path.join(missionDir(projectRoot, missionId), "autopilot.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const [owner, stamp] = fs.readFileSync(file, "utf8").split("\n");
      const at = Number(stamp);
      // A lock whose process has exited (a reloaded window, a crash) is released at once, not after hours.
      if ((Number.isFinite(at) && Date.now() - at > AUTOPILOT_LOCK_STALE_MS) || !processAlive(Number(owner))) {
        fs.rmSync(file, { force: true });
        fs.writeFileSync(file, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function releaseAutopilotLock(projectRoot: string, missionId: string): void {
  fs.rmSync(path.join(missionDir(projectRoot, missionId), "autopilot.lock"), { force: true });
}

export const MISSION_SCHEMA_VERSION = 1;

export function migrateMission(mission: Mission): Mission {
  if (mission.schemaVersion === MISSION_SCHEMA_VERSION) return mission;
  mission.schemaVersion = MISSION_SCHEMA_VERSION;
  mission.evidence ??= [];
  mission.requirements ??= [];
  mission.approvals ??= [];
  return mission;
}

export function loadMission(projectRoot: string, missionId: string): Mission {
  const file = path.join(missionDir(projectRoot, missionId), "mission.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Mission ${missionId} does not exist.`);
  }
  return migrateMission(readJson<Mission>(file));
}

export function activeMissionId(projectRoot: string): string | null {
  const file = path.join(ensureHome(projectRoot).home, "active-mission");
  if (!fs.existsSync(file)) return null;
  const id = fs.readFileSync(file, "utf8").trim();
  return id || null;
}

export function appendEvent(projectRoot: string, missionId: string, event: DomainEvent): void {
  const dir = missionDir(projectRoot, missionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

export function readEvents(projectRoot: string, missionId: string): DomainEvent[] {
  const file = path.join(missionDir(projectRoot, missionId), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DomainEvent);
}

export function listMissionIds(projectRoot: string): string[] {
  const dir = path.join(ensureHome(projectRoot).home, "missions");
  return fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "mission.json")));
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function withExclusiveLock<T>(lockPath: string, staleMs: number, fn: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const at = Number(fs.readFileSync(lockPath, "utf8").split("\n")[1]);
        if (Number.isFinite(at) && Date.now() - at > staleMs) fs.rmSync(lockPath, { force: true });
      } catch {
        // lock vanished between exists and read
      }
      if (Date.now() - started > staleMs) throw new Error(`Timed out waiting for ${lockPath}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function unionBy<T>(left: T[], right: T[], keyOf: (item: T) => string, pick: (current: T, next: T) => T = (_current, next) => next): T[] {
  const map = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const key = keyOf(item);
    if (!key) continue;
    const current = map.get(key);
    map.set(key, current ? pick(current, item) : item);
  }
  return [...map.values()];
}

function preferReview(current: Mission["reviews"][number], next: Mission["reviews"][number]): Mission["reviews"][number] {
  if ((next.repairSuccess ?? 0) !== (current.repairSuccess ?? 0)) return (next.repairSuccess ?? 0) > (current.repairSuccess ?? 0) ? next : current;
  return Date.parse(next.endedAt ?? "") >= Date.parse(current.endedAt ?? "") ? next : current;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeAttempts(left: Record<string, number> = {}, right: Record<string, number> = {}): Record<string, number> {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const next: Record<string, number> = {};
  for (const key of keys) next[key] = Math.max(left[key] ?? 0, right[key] ?? 0);
  return next;
}

function mergeWorkflow(left: Mission["workflow"], right: Mission["workflow"]): Mission["workflow"] {
  const rank: Record<string, number> = { pending: 0, "awaiting-model": 1, "awaiting-user": 2, "not-configured": 3, blocked: 4, skipped: 5, completed: 6 };
  const map = new Map<string, Mission["workflow"][number]>();
  for (const step of [...left, ...right]) {
    const current = map.get(step.skillId);
    if (!current || (rank[step.status] ?? 0) >= (rank[current.status] ?? 0)) map.set(step.skillId, step);
  }
  return left.length > 0 ? left.map((step) => map.get(step.skillId) ?? step) : [...map.values()];
}

function mergePlans(left: Mission["plans"], right: Mission["plans"]): Mission["plans"] {
  const rank: Record<string, number> = { dropped: -1, planned: 0, draft: 1, "ready-for-dev": 2, "in-progress": 3, blocked: 4, "in-review": 5, built: 6, done: 7 };
  const map = new Map<string, Mission["plans"][number]>();
  for (const plan of [...left, ...right]) {
    const current = map.get(plan.ref);
    if (!current || (rank[plan.status] ?? 0) >= (rank[current.status] ?? 0)) map.set(plan.ref, plan);
  }
  return [...map.values()];
}

function mergeExecutions(left: Mission["executions"], right: Mission["executions"]): Mission["executions"] {
  const map = new Map<string, Mission["executions"][number]>();
  for (const item of [...left, ...right]) {
    const current = map.get(item.ticketRef);
    map.set(item.ticketRef, current ? preferExecution(current, item) : item);
  }
  return [...map.values()];
}

function preferExecution(current: Mission["executions"][number], next: Mission["executions"][number]): Mission["executions"][number] {
  if (next.status === "running" && current.endedAt && !next.endedAt) return current;
  if (current.status === "running" && next.endedAt && !current.endedAt) return next;
  return Date.parse(next.updatedAt || "") >= Date.parse(current.updatedAt || "") ? next : current;
}
