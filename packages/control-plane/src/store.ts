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

export function saveMission(projectRoot: string, mission: Mission): void {
  const dir = missionDir(projectRoot, mission.id);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  writeJson(path.join(dir, "mission.json"), mission);
  fs.writeFileSync(path.join(ensureHome(projectRoot).home, "active-mission"), mission.id);
}

export function loadMission(projectRoot: string, missionId: string): Mission {
  const file = path.join(missionDir(projectRoot, missionId), "mission.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Mission ${missionId} does not exist.`);
  }
  return readJson<Mission>(file);
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
