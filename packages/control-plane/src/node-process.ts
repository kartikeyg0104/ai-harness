/**
 * Command and environment that run a Node script from this process. Inside an Electron host such as the
 * VS Code extension host, process.execPath is the Electron helper; it behaves as Node only with
 * ELECTRON_RUN_AS_NODE=1. Plain Node ignores that variable.
 */
export function nodeProcess(): { command: string; env: NodeJS.ProcessEnv } {
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}
