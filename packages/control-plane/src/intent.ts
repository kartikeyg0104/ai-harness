export type IntentName =
  | "forge"
  | "brainstorm"
  | "party"
  | "research"
  | "spec"
  | "brief"
  | "prd"
  | "ux"
  | "architecture"
  | "sprint"
  | "stories"
  | "build"
  | "review"
  | "repair"
  | "attack"
  | "browser"
  | "security"
  | "nfr"
  | "verify"
  | "drift"
  | "correct-course"
  | "tea"
  | "approve-release"
  | "reject-release"
  | "release"
  | "retrospective"
  | "next"
  | "doctor"
  | "unknown";

export interface Intent {
  name: IntentName;
  skillId?: string;
  target?: string;
  text: string;
}

const ROUTES: Array<{ name: IntentName; skillId?: string; pattern: RegExp }> = [
  { name: "next", pattern: /what should i do next|help/i },
  { name: "doctor", pattern: /\bdoctor\b/i },
  { name: "forge", skillId: "bmad-forge-idea", pattern: /\bforge\b/i },
  { name: "brainstorm", skillId: "bmad-brainstorming", pattern: /\bbrainstorm\b/i },
  { name: "party", skillId: "bmad-party-mode", pattern: /\bparty\b/i },
  { name: "research", skillId: "bmad-deep-recon", pattern: /\bresearch\b/i },
  { name: "spec", skillId: "bmad-spec", pattern: /\bspec\b/i },
  { name: "brief", skillId: "bmad-product-brief", pattern: /\bbrief\b/i },
  { name: "prd", skillId: "bmad-prd", pattern: /\bprd\b/i },
  { name: "ux", skillId: "bmad-ux", pattern: /\bux\b/i },
  { name: "architecture", skillId: "bmad-architecture", pattern: /\barchitecture\b/i },
  { name: "sprint", skillId: "bmad-preview-ticketing", pattern: /\bsprint\b/i },
  { name: "build", skillId: "bmad-build", pattern: /\bbuild\b/i },
  { name: "stories", skillId: "bmad-preview-ticketing", pattern: /\bstor(y|ies)\b/i },
  { name: "repair", skillId: "bmad-code-review", pattern: /\brepair\b/i },
  { name: "review", skillId: "bmad-code-review", pattern: /\breview\b/i },
  { name: "attack", skillId: "bmad-next:attack", pattern: /\battack\b/i },
  { name: "browser", skillId: "bmad-next:browser", pattern: /\bbrowser\b/i },
  { name: "security", skillId: "bmad-next:security", pattern: /\bsecurity\b/i },
  { name: "nfr", skillId: "bmad-next:nfr", pattern: /\bnfr\b/i },
  { name: "verify", pattern: /\bverify\b/i },
  { name: "drift", pattern: /\bdrift\b/i },
  { name: "correct-course", skillId: "bmad-correct-course", pattern: /\bcorrect course\b/i },
  { name: "tea", skillId: "tea", pattern: /\btea\b/i },
  { name: "approve-release", pattern: /\bapprove release\b/i },
  { name: "reject-release", pattern: /\breject release\b/i },
  { name: "release", skillId: "bmad-next:release", pattern: /\brelease\b/i },
  { name: "retrospective", skillId: "bmad-retrospective", pattern: /\bretrospective\b/i },
];

export function parseIntent(input: string): Intent {
  const text = input.replace(/^@bmad\s+/i, "").trim();
  const target = text.match(/\b(REQ-\d+|story\s+[\d.]+|\d+\.\d+)\b/i)?.[0];
  for (const route of ROUTES) {
    if (route.pattern.test(text)) return { name: route.name, skillId: route.skillId, target, text };
  }
  return { name: "unknown", text };
}
