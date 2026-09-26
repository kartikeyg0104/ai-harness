import fs from "node:fs";
import path from "node:path";

export interface TestCommand {
  command: string;
  args: string[];
  /** Directory the command runs in. */
  dir: string;
  /** Human-readable command for evidence and logs. */
  label: string;
}

const PYTHON_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)tests?\/.*\.py$/;
const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"];

/**
 * The test command for a ticket worktree when it has no package.json test script: pytest for Python (only the
 * changed test files when there are some), `go test` for Go modules, `cargo test` for Rust, and a Makefile `test`
 * target as the last resort. Null when nothing recognisable exists.
 */
export function detectTestCommand(worktree: string, changedFiles: string[]): TestCommand | null {
  const root = path.resolve(worktree);
  const has = (name: string) => fs.existsSync(path.join(root, name));
  const changed = changedFiles.map((file) => file.replace(/\/$/, ""));
  const python = PYTHON_MARKERS.some(has) || changed.some((file) => file.endsWith(".py"));
  if (python) {
    const tests = changed.filter((file) => PYTHON_TEST.test(file) && fs.existsSync(path.join(root, file)));
    const args = ["-m", "pytest", "-q", "-p", "no:cacheprovider", ...tests];
    return { command: pythonBinary(), args, dir: root, label: `python -m pytest -q${tests.length > 0 ? ` ${tests.join(" ")}` : ""}` };
  }
  if (has("go.mod")) {
    const packages = [...new Set(changed.filter((file) => file.endsWith(".go")).map((file) => `./${path.dirname(file)}`))];
    const args = ["test", ...(packages.length > 0 ? packages : ["./..."])];
    return { command: "go", args, dir: root, label: `go ${args.join(" ")}` };
  }
  if (has("Cargo.toml")) return { command: "cargo", args: ["test"], dir: root, label: "cargo test" };
  if (has("Makefile") && /^test:/m.test(fs.readFileSync(path.join(root, "Makefile"), "utf8"))) {
    return { command: "make", args: ["test"], dir: root, label: "make test" };
  }
  return null;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".bmad-next", "_bmad-output", "dist", "build", "coverage", ".next", "vendor"]);
const JS_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function readManifest(dir: string): { scripts?: Record<string, unknown>; workspaces?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function testScript(dir: string): string | null {
  const script = readManifest(dir)?.scripts?.test;
  return typeof script === "string" && script.trim() ? script : null;
}

/** Directories, relative to the root ("" is the root), whose package.json has a test script, up to three levels deep. */
export function npmTestPackages(worktree: string): string[] {
  const root = path.resolve(worktree);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (testScript(dir)) found.push(path.relative(root, dir).split(path.sep).join("/"));
    if (depth === 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The npm test run for a change. `dir` is the package that contains the change; when it has no test script (a
 * monorepo whose root only lists workspaces, or a change in a package without tests), the packages that do have one
 * run instead: the one the change touches, else every workspace with `--if-present`, else the only test package.
 */
export function npmTestPlan(worktree: string, changedFiles: string[], dir: string): TestCommand | null {
  const root = path.resolve(worktree);
  const where = (target: string) => path.relative(root, target).split(path.sep).join("/");
  const single = (target: string): TestCommand => ({ command: "npm", args: ["test"], dir: target, label: where(target) ? `npm test (in ${where(target)})` : "npm test" });
  if (testScript(dir)) return single(dir);
  const packages = npmTestPackages(root).filter((item) => item !== "");
  if (packages.length === 0) return null;
  const changed = changedFiles.map((file) => file.replace(/\/$/, ""));
  const touched = packages.filter((pkg) => changed.some((file) => file === pkg || file.startsWith(`${pkg}/`)));
  if (touched.length === 1) return single(path.join(root, touched[0] ?? ""));
  if (packages.length === 1) return single(path.join(root, packages[0] ?? ""));
  if (readManifest(root)?.workspaces) {
    return { command: "npm", args: ["test", "--workspaces", "--if-present"], dir: root, label: "npm test --workspaces --if-present" };
  }
  return single(path.join(root, (touched[0] ?? packages[0]) as string));
}

/**
 * Packages a change touches that have their own build script, relative to the root: the nearest package.json above
 * each changed file. The root counts only when it is not a workspace list. A monorepo's CI builds these after the
 * tests, and a type error in a file no test imports only shows up there.
 */
export function buildPackages(worktree: string, changedFiles: string[]): string[] {
  const root = path.resolve(worktree);
  const found = new Set<string>();
  for (const file of changedFiles.map((item) => item.replace(/\/$/, "")).filter(Boolean)) {
    for (let dir = path.dirname(path.resolve(root, file)); dir === root || dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      const manifest = fs.existsSync(path.join(dir, "package.json")) ? readManifest(dir) : null;
      if (fs.existsSync(path.join(dir, "package.json"))) {
        const build = manifest?.scripts?.build;
        if (typeof build === "string" && build.trim() && !(dir === root && manifest?.workspaces)) found.add(path.relative(root, dir).split(path.sep).join("/"));
        break;
      }
      if (dir === root) break;
    }
  }
  return [...found].sort();
}

function framework(dir: string, script: string): string | null {
  const manifest = readManifest(dir);
  const declared = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) };
  for (const name of ["vitest", "jest", "mocha", "ava", "tap"]) {
    if (new RegExp(`\\b${name}\\b`).test(script) || name in declared) return name === "jest" ? "Jest" : name === "vitest" ? "Vitest" : name;
  }
  if (/node\s+(--[\w-]+\s+)*--test\b/.test(script)) return "node:test";
  return null;
}

function sampleTests(dir: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (found.length >= limit || depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full, depth + 1);
      else if (entry.isFile() && JS_TEST_FILE.test(entry.name)) found.push(full);
    }
  };
  walk(dir, 0);
  return found;
}

/**
 * How a repository without a root test script is tested, for the build prompt: each package with a test script, its
 * framework, and existing test files to copy. Null when no package has one.
 */
export function describeNpmTests(worktree: string): string | null {
  const root = path.resolve(worktree);
  const packages = npmTestPackages(root).filter((item) => item !== "");
  if (packages.length === 0) return null;
  const lines = packages.map((pkg) => {
    const dir = path.join(root, pkg);
    const script = testScript(dir) ?? "";
    const name = framework(dir, script);
    const samples = sampleTests(dir, 3).map((file) => path.relative(root, file).split(path.sep).join("/"));
    return `- ${pkg}: \`npm test\` runs \`${script}\`${name ? ` (${name})` : ""}${samples.length > 0 ? `; existing tests: ${samples.join(", ")}` : ""}`;
  });
  return [
    "The repository root has no test script. These packages have their own:",
    ...lines,
    "Add or update tests in the package your change belongs to, next to the existing tests and with the same framework, imports, and mocks. Do not add a test script to the root package.json, and do not replace an existing test script. When your change is in a package without tests, add the tests to the package above that exercises the same behaviour (for example, the server API the page calls).",
  ].join("\n");
}

/**
 * The lockfile that governs an npm package: the nearest package-lock.json or npm-shrinkwrap.json from `dir` up to
 * the worktree root. In a workspace monorepo that is the root lockfile. Null when there is none.
 */
export function npmLockRoot(worktree: string, dir: string): string | null {
  const root = path.resolve(worktree);
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (["package-lock.json", "npm-shrinkwrap.json"].some((name) => fs.existsSync(path.join(current, name)))) return current;
    if (current === root || !current.startsWith(root)) return null;
  }
}

function pythonBinary(): string {
  const venv = process.env.VIRTUAL_ENV;
  if (venv && fs.existsSync(path.join(venv, "bin", "python"))) return path.join(venv, "bin", "python");
  return "python3";
}

/** A test run that collected nothing is not a pass: pytest exits 5, and node:test prints "tests 0". */
export function nonNodeRanTests(stdout: string): boolean {
  return !/\bno tests ran\b|collected 0 items/i.test(stdout);
}
