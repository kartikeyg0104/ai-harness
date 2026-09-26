import type { AgentContract, Autonomy, PolicyDecision } from "./types";

export interface PolicyRule {
  id: string;
  decision: PolicyDecision;
  test: (command: string) => boolean;
}

export const COMMAND_RULES: PolicyRule[] = [
  { id: "drop-database", decision: "block", test: (command) => /\bdrop\s+database\b/i.test(command) },
  { id: "mkfs", decision: "block", test: (command) => /\bmkfs\b/i.test(command) },
  { id: "rm-root", decision: "block", test: (command) => /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$)/.test(command) },
  { id: "production-deploy", decision: "approval", test: (command) => /\bproduction\s+deploy\b/i.test(command) },
  { id: "git-push", decision: "approval", test: (command) => /^\s*git\s+push\b/.test(command) },
  { id: "npm-test", decision: "allow", test: (command) => /^\s*npm\s+test\b/.test(command) },
  { id: "git-diff", decision: "allow", test: (command) => /^\s*git\s+diff\b/.test(command) },
  { id: "git-status", decision: "allow", test: (command) => /^\s*git\s+status\b/.test(command) },
  { id: "git-branch", decision: "allow", test: (command) => /^\s*git\s+branch\b/.test(command) },
  { id: "git-worktree-list", decision: "allow", test: (command) => /^\s*git\s+worktree\s+list\b/.test(command) },
  { id: "playwright-navigate", decision: "allow", test: (command) => /^\s*playwright\s+navigate\s+https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|\s|$)/i.test(command) },
];

export function decideCommand(command: string, autonomy: Autonomy): { decision: PolicyDecision; rule: string } {
  const matched = COMMAND_RULES.find((rule) => rule.test(command));
  const base = matched ?? { id: "default-approval", decision: "approval" as const };
  if (autonomy === "observe") {
    return { decision: "block", rule: `${base.id}:observe` };
  }
  if (base.decision === "block") return { decision: "block", rule: base.id };
  if (base.decision === "approval" && autonomy !== "full-mission") {
    return { decision: "approval", rule: base.id };
  }
  if (base.decision === "approval" && autonomy === "full-mission") {
    return { decision: "approval", rule: base.id };
  }
  return { decision: base.decision, rule: base.id };
}

export function authorizeAgent(
  agent: AgentContract,
  action: { type: "read" | "write"; path: string } | { type: "exec"; command: string },
): { allowed: boolean; reason: string } {
  if (action.type === "exec") {
    const blocked = agent.permissions.blocked.find((pattern) => commandMatches(pattern, action.command));
    if (blocked) return { allowed: false, reason: `Blocked by contract: ${blocked}` };
    const allowed = agent.permissions.execute.some((pattern) => commandMatches(pattern, action.command));
    return allowed
      ? { allowed: true, reason: "Execute pattern matched." }
      : { allowed: false, reason: "Command is outside the agent execute contract." };
  }
  const blocked = agent.permissions.blocked.find((pattern) => globMatch(pattern, action.path));
  if (blocked) return { allowed: false, reason: `Path blocked by contract: ${blocked}` };
  const patterns = action.type === "write" ? agent.permissions.write : agent.permissions.read;
  const matched = patterns.some((pattern) => globMatch(pattern, action.path));
  return matched
    ? { allowed: true, reason: `${action.type} pattern matched.` }
    : { allowed: false, reason: `Path is outside the agent ${action.type} contract.` };
}

function commandMatches(pattern: string, command: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  return command.trim().toLowerCase().includes(normalized);
}

export function globMatch(pattern: string, file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${source}$`).test(normalized);
}
