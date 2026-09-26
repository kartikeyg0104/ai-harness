import type { EpicRecord, TicketEntry } from "./types";

export function renderTicketTree(epics: EpicRecord[], tickets: TicketEntry[]): { initiative: string; epics: Record<string, string> } {
  const initiative = [
    "# tickets.toml — initiative children. tickets.py reads this file.",
    "# Status is not stored here. A plan file carries status.",
    "",
    ...epics.map((epic) => renderEpic(epic)),
  ].join("\n");
  const files: Record<string, string> = {};
  for (const epic of epics) {
    const entries = tickets.filter((ticket) => ticket.epicId === epic.id);
    files[`${epic.slug}/tickets.toml`] = [
      "# tickets.toml — epic children. Status lives in each plan file.",
      "",
      ...entries.map((entry) => renderEntry(entry)),
    ].join("\n");
  }
  return { initiative, epics: files };
}

function renderEpic(epic: EpicRecord): string {
  return [
    "[[epic]]",
    `id = ${epic.id}`,
    `slug = ${tomlString(epic.slug)}`,
    `title = ${tomlString(epic.title)}`,
    `covers = ${tomlArray(epic.covers)}`,
    epic.after.length > 0 ? `after = ${tomlInline(epic.after.map((item) => `{ epic = ${item.epic}, needs = ${tomlString(item.needs)} }`))}` : "",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderEntry(entry: TicketEntry): string {
  return [
    "[[entry]]",
    `id = ${entry.id}`,
    `type = ${tomlString(entry.type)}`,
    `title = ${tomlString(entry.title)}`,
    `description = ${tomlString(entry.description)}`,
    `verify = ${tomlString(entry.verify)}`,
    `covers = ${tomlArray(entry.covers)}`,
    `after = ${tomlArray(entry.after.map(String))}`,
    `hits = ${entry.hits ? "true" : "false"}`,
    `risk = ${tomlString(entry.risk)}`,
    "",
  ].join("\n");
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInline(values: string[]): string {
  return `[${values.join(", ")}]`;
}

export function assertTomlHasNoStatus(toml: string): void {
  if (/^\s*status\s*=/m.test(toml)) {
    throw new Error("tickets.toml must not carry status. Status belongs in the plan file.");
  }
}
