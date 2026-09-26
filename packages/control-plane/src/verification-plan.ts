import fs from "node:fs";
import path from "node:path";
import type { BrowserAssertion, BrowserScenario, BrowserStep } from "./browser";
import { LATENCY_PROBE, PREVIEW_MARKER } from "./preview";
import { extractJson } from "./reviewer";
import type { NfrRequirement } from "./types";

export const PLAN_PROMPT_VERSION = "verification-plan-v1";

export interface VerificationPlan {
  scenario: BrowserScenario;
  nfr: Array<NfrRequirement & { source: string }>;
}

const ACTIONS = new Set(["navigate", "click", "fill", "select", "wait", "screenshot"]);
const ASSERTIONS = new Set(["visible", "text", "url", "attribute", "count"]);
const OPERATORS = new Set(["<", "<=", ">", ">=", "=="]);
const SOURCE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json"]);

/** App source handed to the planner so selectors come from the code, not from a guess. */
export function appSource(dir: string, budget = 40000): string {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".test.js")) files.push(absolute);
    }
  };
  walk(dir);
  let used = 0;
  const parts: string[] = [];
  for (const file of files.sort()) {
    const body = fs.readFileSync(file, "utf8");
    if (used + body.length > budget) {
      parts.push(`--- ${path.relative(dir, file)} (omitted: over the prompt budget)`);
      continue;
    }
    used += body.length;
    parts.push(`--- ${path.relative(dir, file)}\n${body}`);
  }
  return parts.join("\n");
}

export function planPrompt(input: {
  requirementId: string;
  title: string;
  acceptance: string[];
  nonGoals: string;
  nfrText: string;
  source: string;
}): string {
  return [
    "You design the browser acceptance test and the measurable NFRs for one requirement of a web app.",
    "You do not run anything. Reply with one JSON object and no other text.",
    `promptVersion: ${PLAN_PROMPT_VERSION}`,
    `Requirement ${input.requirementId}: ${input.title}`,
    `Acceptance criteria:\n${input.acceptance.map((item) => `- ${item}`).join("\n") || "- (none declared)"}`,
    input.nonGoals ? `Out of scope: ${input.nonGoals}` : "",
    "",
    "Browser scenario rules:",
    `- The app is served from ${PREVIEW_MARKER}. Every navigate target is ${PREVIEW_MARKER} or ${PREVIEW_MARKER}/<path>. Navigating to it again reloads the page and keeps localStorage.`,
    "- Step actions: navigate, click, fill, select, wait, screenshot. Each step has target (a CSS selector, or the URL for navigate), optional value, and a short name.",
    "- Assertions run once, after every step. Kinds: visible, text (target innerText contains expected), attribute (needs attribute), count (number of elements matching target equals expected, as a string), url.",
    "- Use selectors that exist in the source below. Exercise every acceptance criterion and every capability named in the requirement title through the UI, then reload, then assert the final state proves it.",
    "- Decide the final state first, then write steps that produce it. Every assertion must hold for that final state after the reload.",
    "- Use several distinct items. When a criterion removes an item, remove a different item from the ones you assert on, so the assertions still prove the other criteria.",
    "- Count what remains after removals. Assert on an item whose state changed and on an item that did not change, so the reload is shown to keep both.",
    "",
    "NFR rules:",
    '- Only metric "latency" (unit "ms", time for the served page to answer) can be measured here.',
    "- Take the target from the PRD or SPEC when they state one. Otherwise propose one and say so in source.",
    "",
    input.nfrText ? `NFR text from the mission artifacts:\n${input.nfrText}` : "The mission artifacts state no NFR text.",
    "",
    "App source:",
    input.source || "(no source found)",
    "",
    "JSON shape:",
    `{"status":"complete","browser":{"name":"...","steps":[{"action":"navigate","target":"${PREVIEW_MARKER}","name":"open"}],"assertions":[{"kind":"count","target":"...","expected":"1"}]},"nfr":[{"metric":"latency","operator":"<","target":500,"unit":"ms","source":"PRD NFR-1"}]}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function extractObject(raw: string): Record<string, unknown> | null {
  try {
    return extractJson(raw);
  } catch {
    return null;
  }
}

const previewTarget = (value: string) => value === PREVIEW_MARKER || value.startsWith(`${PREVIEW_MARKER}/`);

/**
 * Validates planner output. The planner proposes; nothing passes from it. Playwright and the latency probe
 * decide the results later. Returns a reason string when the plan cannot be used.
 */
export function parsePlan(raw: string, requirementId: string): VerificationPlan | string {
  const parsed = extractObject(raw);
  if (!parsed) return "Planner output was not a JSON object.";
  if (parsed.status !== "complete") return `Planner status was ${String(parsed.status)}, not complete.`;
  const browser = parsed.browser as Record<string, unknown> | undefined;
  if (!browser || typeof browser !== "object") return "Planner returned no browser scenario.";
  if (!Array.isArray(browser.steps) || browser.steps.length === 0) return "Browser scenario has no steps.";
  if (!Array.isArray(browser.assertions) || browser.assertions.length === 0) return "Browser scenario has no assertions.";
  const steps: BrowserStep[] = [];
  for (const item of browser.steps as unknown[]) {
    const step = (item ?? {}) as Record<string, unknown>;
    if (typeof step.action !== "string" || !ACTIONS.has(step.action)) return `Browser step action ${String(step.action)} is not supported.`;
    const target = typeof step.target === "string" ? step.target.trim() : "";
    if (step.action === "navigate" && !previewTarget(target)) return `Browser navigation must stay on ${PREVIEW_MARKER}; got ${target || "(none)"}.`;
    if ((step.action === "click" || step.action === "fill" || step.action === "select") && !target) return `Browser ${step.action} step has no target.`;
    steps.push({
      action: step.action as BrowserStep["action"],
      target: target || undefined,
      value: typeof step.value === "string" ? step.value : undefined,
      name: typeof step.name === "string" && step.name.trim() ? step.name.trim() : `${step.action}-${steps.length + 1}`,
    });
  }
  if (steps[0]?.action !== "navigate") return "Browser scenario must start by navigating to the preview.";
  const assertions: BrowserAssertion[] = [];
  for (const item of browser.assertions as unknown[]) {
    const assertion = (item ?? {}) as Record<string, unknown>;
    if (typeof assertion.kind !== "string" || !ASSERTIONS.has(assertion.kind)) return `Browser assertion kind ${String(assertion.kind)} is not supported.`;
    if (typeof assertion.target !== "string" || !assertion.target.trim()) return "Browser assertion has no target.";
    if (typeof assertion.expected !== "string" && typeof assertion.expected !== "number") return "Browser assertion has no expected value.";
    if (assertion.kind === "attribute" && (typeof assertion.attribute !== "string" || !assertion.attribute.trim())) return "Attribute assertion names no attribute.";
    assertions.push({
      kind: assertion.kind as BrowserAssertion["kind"],
      target: assertion.target.trim(),
      expected: String(assertion.expected),
      attribute: typeof assertion.attribute === "string" ? assertion.attribute.trim() : undefined,
    });
  }
  const nfr: VerificationPlan["nfr"] = [];
  for (const [index, item] of (Array.isArray(parsed.nfr) ? (parsed.nfr as unknown[]) : []).entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    if (entry.metric !== "latency" || entry.unit !== "ms") continue;
    const target = Number(entry.target);
    if (typeof entry.operator !== "string" || !OPERATORS.has(entry.operator) || !Number.isFinite(target) || target <= 0) continue;
    nfr.push({
      id: `NFR-${String(index + 1).padStart(3, "0")}`,
      category: "performance",
      metric: "latency",
      operator: entry.operator as NfrRequirement["operator"],
      target,
      unit: "ms",
      verificationMethod: JSON.stringify(["node", "-e", LATENCY_PROBE, PREVIEW_MARKER]),
      source: typeof entry.source === "string" && entry.source.trim() ? entry.source.trim().slice(0, 200) : "planner",
    });
  }
  return {
    scenario: {
      id: `BROWSER-${requirementId}`,
      requirementId,
      name: typeof browser.name === "string" && browser.name.trim() ? browser.name.trim().slice(0, 120) : `Acceptance for ${requirementId}`,
      startUrl: PREVIEW_MARKER,
      steps,
      assertions,
    },
    nfr,
  };
}
