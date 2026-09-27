import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./types";

function timedOut(error: Error | undefined): boolean {
  if (!error) return false;
  const coded = error as Error & { code?: string };
  return coded.code === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(error.message);
}

/** Where running commands record their process ids, so a person's Stop can end exactly the work in flight. */
export function stepPidDir(ownerPid = process.pid): string {
  return path.join(os.tmpdir(), `bmad-next-steps-${ownerPid}`);
}

export const processRunner: CommandRunner = {
  which(bin: string): string | null {
    const result = spawnSync("which", [bin], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  },
  run(command: string, args: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): CommandResult {
    const started = Date.now();
    // A NUL byte cannot cross exec(); drop it rather than fail the whole run.
    const clean = args.map((arg) => arg.replace(/\0/g, ""));
    // The command starts through sh, which writes its own pid and then execs the command in its place, so the
    // recorded pid is the command's. Nothing else changes: same process, same exit code, same timeout kill.
    const tracked = process.platform !== "win32";
    let pidFile = "";
    if (tracked) {
      const dir = stepPidDir();
      fs.mkdirSync(dir, { recursive: true });
      pidFile = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
    }
    const result = spawnSync(tracked ? "/bin/sh" : command, tracked ? ["-c", 'echo $$ > "$0"; exec "$@"', pidFile, command, ...clean] : clean, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      // PWD must match cwd: OpenCode reads its working directory from the inherited PWD, not from the process cwd.
      env: { ...process.env, ...env, PWD: path.resolve(cwd) },
    });
    if (pidFile) fs.rmSync(pidFile, { force: true });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
      durationMs: Date.now() - started,
      timedOut: timedOut(result.error),
    };
  },
};

/**
 * Ends every command this process is running for the control plane, with everything those commands started
 * (an agent CLI and its tools, a test runner and its workers). Returns how many processes were signalled.
 */
export function stopRunningSteps(ownerPid = process.pid): number {
  const dir = stepPidDir(ownerPid);
  if (!fs.existsSync(dir)) return 0;
  const roots = fs
    .readdirSync(dir)
    .map((name) => Number(fs.readFileSync(path.join(dir, name), "utf8").trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
  if (roots.length === 0) return 0;
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const doomed = new Set<number>();
  const visit = (pid: number) => {
    if (doomed.has(pid)) return;
    doomed.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  roots.forEach(visit);
  // Children first, so a parent cannot restart what was just stopped.
  const order = [...doomed].reverse();
  for (const pid of order) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => {
    for (const pid of order) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited after SIGTERM.
      }
    }
  }, 1500).unref();
  return doomed.size;
}
