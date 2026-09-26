import { parentPort, workerData } from "node:worker_threads";
import { BmadControlPlane, loadProjectEnv } from "@bmad-next/control-plane";

/**
 * Runs one long control-plane operation off the extension host thread. Model runs, builds, reviews, and scans
 * spawn processes synchronously for minutes; running them here keeps the editor responsive.
 */
export const WORKER_METHODS = [
  "runSkill",
  "stories",
  "executeTicket",
  "reviewTicket",
  "repairTicket",
  "attackTicket",
  "planVerification",
  "runBrowser",
  "runSecurity",
  "measureNfr",
  "verifyArchitecture",
  "verifyTraceability",
  "releaseGate",
  "retrospective",
  "autopilot",
] as const;

export type WorkerMethod = (typeof WORKER_METHODS)[number];

interface Job {
  root: string;
  method: WorkerMethod;
  args: unknown[];
}

if (parentPort) {
  const port = parentPort;
  const job = workerData as Job;
  void (async () => {
    try {
      if (!WORKER_METHODS.includes(job.method)) throw new Error(`${job.method} is not a worker operation.`);
      loadProjectEnv(job.root);
      const plane = new BmadControlPlane(job.root);
      const operation = plane[job.method] as (...args: unknown[]) => unknown;
      // The autopilot streams each step back so the editor can show progress while it runs.
      const args = job.method === "autopilot" ? [job.args[0], { log: (message: string) => port.postMessage({ progress: message }) }] : job.args;
      const result: unknown = await operation.apply(plane, args);
      port.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) as unknown });
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
}
