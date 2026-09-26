import fs from "node:fs";
import path from "node:path";
import { currentResultFor } from "./quality";
import type { Mission } from "./types";

export const DEMO_DIR_NAME = ".bmad-demo";

export function demoDirectory(projectRoot: string): string {
  return path.resolve(projectRoot, DEMO_DIR_NAME);
}

export function assertDemoPath(projectRoot: string, target: string): string {
  const root = path.resolve(projectRoot);
  const demo = demoDirectory(root);
  const resolved = path.resolve(target);
  const inside = resolved === demo || resolved.startsWith(demo + path.sep);
  if (!inside || path.basename(demo) !== DEMO_DIR_NAME) {
    throw new Error("Demo cleanup refused a path outside .bmad-demo.");
  }
  return resolved;
}

export function resetDemo(projectRoot: string): { removed: string } {
  const demo = assertDemoPath(projectRoot, demoDirectory(projectRoot));
  if (fs.existsSync(demo)) {
    if (fs.lstatSync(demo).isSymbolicLink()) throw new Error("Demo cleanup refused a symlink.");
    fs.rmSync(demo, { recursive: true, force: true });
  }
  return { removed: demo };
}

function latest(mission: Mission, kind: string): string {
  return currentResultFor(mission, kind) ?? "NOT_RUN";
}

export function formatMissionStatus(mission: Mission): string {
  const ticket = mission.tickets.at(-1)?.ref ?? "none";
  const execution = [...(mission.executions ?? [])].reverse().find((item) => item.ticketRef === ticket) ?? mission.executions?.at(-1);
  const review = mission.reviews?.at(-1);
  const attack = mission.attacks?.at(-1);
  return [
    `mission\n${mission.id}`,
    `current phase\n${mission.phase}`,
    `ticket\n${ticket}`,
    `runtime\n${execution?.runtime ?? "not-configured"}`,
    `agent\n${execution?.agent ?? "unassigned"}`,
    `worktree\n${execution?.worktree ?? "absent"}`,
    `test\n${latest(mission, "unit")}`,
    `review\n${review?.status ?? "NOT_RUN"}`,
    `attack\n${attack?.status ?? "NOT_RUN"}`,
    `browser\n${latest(mission, "browser")}`,
    `security\n${latest(mission, "security")}`,
    `NFR\n${latest(mission, "nfr")}`,
    `architecture\n${latest(mission, "architecture")}`,
    `traceability\n${latest(mission, "traceability")}`,
    `release\n${mission.lastVerifiedBuild ? "RECORDED" : "NOT_RECORDED"}`,
  ].join("\n");
}

export function formatDemoReport(mission: Mission): string {
  const review = mission.reviews?.at(-1);
  const attack = mission.attacks?.at(-1);
  return [
    "BMAD Next Demo",
    `Mission:\n${mission.id}`,
    `Current phase:\n${mission.phase}`,
    `Requirements:\n${mission.requirements.map((item) => item.id).join(", ") || "none"}`,
    `Tickets:\n${mission.tickets.map((item) => item.ref).join(", ") || "none"}`,
    `Tests:\n${latest(mission, "unit")}`,
    `Review:\n${review?.status ?? "NOT_RUN"}`,
    `Attack:\n${attack?.status ?? "NOT_RUN"}`,
    `Browser:\n${latest(mission, "browser")}`,
    `Security:\n${latest(mission, "security")}`,
    `NFR:\n${latest(mission, "nfr")}`,
    `Architecture:\n${latest(mission, "architecture")}`,
    `Traceability:\n${latest(mission, "traceability")}`,
    `Release:\n${mission.lastVerifiedBuild ? "RECORDED" : "NOT_RECORDED"}`,
  ].join("\n");
}
