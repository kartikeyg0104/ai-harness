import fs from "node:fs";
import path from "node:path";

/**
 * Load KEY=VALUE pairs from the project `.env` into process.env when a key is unset or empty.
 * Existing environment values win so a launched Extension Host or test can override the file.
 * Values are never logged.
 */
export function loadProjectEnv(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = path.join(projectRoot, ".env");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  const applied: string[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const cut = body.indexOf("=");
    if (cut <= 0) continue;
    const key = body.slice(0, cut).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const current = env[key];
    if (current !== undefined && current !== "") continue;
    env[key] = unquote(body.slice(cut + 1).trim());
    applied.push(key);
  }
  return applied;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
