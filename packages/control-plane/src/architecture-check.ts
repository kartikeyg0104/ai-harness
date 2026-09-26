import fs from "node:fs";
import path from "node:path";
import type { ArchitectureDecision } from "./types";

export interface ArchitectureViolation {
  code: "COMPONENT_MISSING" | "FORBIDDEN_DEPENDENCY" | "TECHNOLOGY_MISSING" | "LAYER_MISSING" | "OWNERSHIP_MISSING";
  message: string;
  path?: string;
  blocking: boolean;
}

export interface ArchitectureVerification {
  declaredComponents: string[];
  detectedComponents: string[];
  declaredTechnologies: string[];
  detectedTechnologies: string[];
  dependencies: string[];
  violations: ArchitectureViolation[];
  evidence: string[];
  status: "PASS" | "FAIL" | "BLOCKED";
  executed: true;
  timestamp: string;
}

function walk(dir: string, root: string, files: string[]): void {
  if (files.length >= 5000 || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".bmad-next" || entry.name === "dist") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, root, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
}

function dependenciesOf(root: string): string[] {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})];
  } catch {
    return [];
  }
}

function technologiesOf(files: string[], dependencies: string[], root: string): string[] {
  const found = new Set<string>();
  if (fs.existsSync(path.join(root, "package.json")) || files.some((file) => file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))) found.add("node");
  if (files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) found.add("typescript");
  if (files.some((file) => file.endsWith(".py"))) found.add("python");
  for (const dependency of dependencies) found.add(dependency.toLowerCase());
  return [...found];
}

export function verifyArchitectureTree(input: { root: string; declared: ArchitectureDecision[]; timestamp: string }): ArchitectureVerification {
  const files: string[] = [];
  walk(input.root, input.root, files);
  const dependencies = dependenciesOf(input.root);
  const detectedTechnologies = technologiesOf(files, dependencies, input.root);
  const declaredComponents = input.declared.filter((item) => item.kind === "component" || item.kind === "layer" || item.kind === "ownership").map((item) => item.choice);
  const declaredTechnologies = input.declared.filter((item) => item.kind === "technology").map((item) => item.choice);
  const violations: ArchitectureViolation[] = [];
  if (input.declared.length === 0) {
    return {
      declaredComponents,
      detectedComponents: files.slice(0, 200),
      declaredTechnologies,
      detectedTechnologies,
      dependencies,
      violations,
      evidence: files.slice(0, 50),
      status: "BLOCKED",
      executed: true,
      timestamp: input.timestamp,
    };
  }
  for (const decision of input.declared) {
    if (decision.kind === "component") {
      const found = files.some((file) => file === decision.choice || file.endsWith(`/${decision.choice}`) || path.basename(file) === decision.choice);
      if (!found) violations.push({ code: "COMPONENT_MISSING", message: `Declared component ${decision.choice} was not found in the repository.`, path: decision.choice, blocking: true });
    }
    if (decision.kind === "layer" || decision.kind === "ownership") {
      const directory = decision.choice.split(":")[0] ?? decision.choice;
      if (!fs.existsSync(path.join(input.root, directory))) {
        violations.push({
          code: decision.kind === "layer" ? "LAYER_MISSING" : "OWNERSHIP_MISSING",
          message: `Declared ${decision.kind} ${decision.choice} is not a directory in the repository.`,
          path: directory,
          blocking: true,
        });
      }
    }
    if (decision.kind === "technology") {
      const name = decision.choice.toLowerCase();
      if (!detectedTechnologies.some((item) => item.toLowerCase() === name)) {
        violations.push({ code: "TECHNOLOGY_MISSING", message: `Declared technology ${decision.choice} was not detected.`, blocking: true });
      }
    }
    if (decision.kind === "forbidden" && dependencies.some((item) => item.toLowerCase() === decision.choice.toLowerCase())) {
      violations.push({ code: "FORBIDDEN_DEPENDENCY", message: `Forbidden dependency ${decision.choice} is installed.`, path: "package.json", blocking: true });
    }
  }
  return {
    declaredComponents,
    detectedComponents: files.slice(0, 200),
    declaredTechnologies,
    detectedTechnologies,
    dependencies,
    violations,
    evidence: files.slice(0, 50),
    status: violations.some((item) => item.blocking) ? "FAIL" : "PASS",
    executed: true,
    timestamp: input.timestamp,
  };
}
