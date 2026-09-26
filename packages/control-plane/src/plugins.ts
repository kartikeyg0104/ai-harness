import fs from "node:fs";
import path from "node:path";

export interface PluginPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
  network: boolean;
  credentials: boolean;
  filesystem: string[];
}

export interface PluginManifest {
  id: string;
  version: string;
  source: string;
  license: string;
  tools: string[];
  permissions: PluginPermissions;
}

export interface PluginRecord extends PluginManifest {
  enabled: boolean;
  installedAt: string;
}

export function listPlugins(root: string): PluginRecord[] {
  const file = pluginFile(root);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { plugins?: PluginRecord[] };
  return parsed.plugins ?? [];
}

export function installPlugin(root: string, manifest: PluginManifest, at: string): PluginRecord {
  validateManifest(manifest);
  const plugins = listPlugins(root).filter((item) => item.id !== manifest.id);
  const record: PluginRecord = { ...manifest, tools: [...manifest.tools], permissions: { ...manifest.permissions, filesystem: [...manifest.permissions.filesystem] }, enabled: false, installedAt: at };
  plugins.push(record);
  writePlugins(root, plugins);
  return record;
}

export function setPluginEnabled(root: string, id: string, enabled: boolean): PluginRecord {
  const plugins = listPlugins(root);
  const plugin = plugins.find((item) => item.id === id);
  if (!plugin) throw new Error(`Plugin ${id} is not installed.`);
  plugin.enabled = enabled;
  writePlugins(root, plugins);
  return plugin;
}

export function removePlugin(root: string, id: string): PluginRecord[] {
  const plugins = listPlugins(root);
  if (!plugins.some((item) => item.id === id)) throw new Error(`Plugin ${id} is not installed.`);
  const next = plugins.filter((item) => item.id !== id);
  writePlugins(root, next);
  return next;
}

function validateManifest(manifest: PluginManifest): void {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(manifest.id)) throw new Error("Plugin id must be a short lowercase name.");
  if (!manifest.version.trim() || !manifest.source.trim() || !manifest.license.trim()) {
    throw new Error("A plugin needs a version, source, and license.");
  }
  const permissions = manifest.permissions;
  if (!permissions || !Array.isArray(permissions.filesystem) || typeof permissions.read !== "boolean" || typeof permissions.write !== "boolean" || typeof permissions.execute !== "boolean" || typeof permissions.network !== "boolean" || typeof permissions.credentials !== "boolean") {
    throw new Error("A plugin must declare read, write, execute, network, credentials, and filesystem permissions.");
  }
  if (!Array.isArray(manifest.tools)) throw new Error("A plugin must declare its tools.");
}

function pluginFile(root: string): string {
  return path.join(root, ".bmad-next", "plugins.json");
}

function writePlugins(root: string, plugins: PluginRecord[]): void {
  const file = pluginFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ plugins }, null, 2));
}
