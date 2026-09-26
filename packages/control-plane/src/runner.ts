import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./types";

function timedOut(error: Error | undefined): boolean {
  if (!error) return false;
  const coded = error as Error & { code?: string };
  return coded.code === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(error.message);
}

export const processRunner: CommandRunner = {
  which(bin: string): string | null {
    const result = spawnSync("which", [bin], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  },
  run(command: string, args: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): CommandResult {
    const started = Date.now();
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      // PWD must match cwd: OpenCode reads its working directory from the inherited PWD, not from the process cwd.
      env: { ...process.env, ...env, PWD: path.resolve(cwd) },
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
      durationMs: Date.now() - started,
      timedOut: timedOut(result.error),
    };
  },
};
