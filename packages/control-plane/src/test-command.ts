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

function pythonBinary(): string {
  const venv = process.env.VIRTUAL_ENV;
  if (venv && fs.existsSync(path.join(venv, "bin", "python"))) return path.join(venv, "bin", "python");
  return "python3";
}

/** A test run that collected nothing is not a pass: pytest exits 5, and node:test prints "tests 0". */
export function nonNodeRanTests(stdout: string): boolean {
  return !/\bno tests ran\b|collected 0 items/i.test(stdout);
}
