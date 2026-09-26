import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BmadControlPlane } from "../plane";
import { detectTestCommand, nonNodeRanTests } from "../test-command";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("an issue mission uses the quick workflow with one requirement and no forge", () => {
  const plane = new BmadControlPlane(tempDir("ai-harness-issue-"));
  const mission = plane.createMission("Resolve GitHub issue o/r#1: crash on empty input\n\nThe parser throws on an empty string.", {
    issue: { title: "o/r#1 crash on empty input", acceptance: "The parser returns an empty result for an empty string." },
  });
  assert.equal(mission.mode, "quick");
  assert.equal(mission.complexity, "simple");
  assert.equal(mission.forge, undefined);
  assert.deepEqual(mission.workflow.map((step) => step.skillId), ["bmad-spec", "bmad-build", "bmad-code-review"]);
  assert.equal(mission.requirements.length, 1);
  assert.deepEqual(mission.requirements[0].acceptance_criteria, ["The parser returns an empty result for an empty string."]);
  const ticketed = plane.stories(mission.id);
  assert.equal(ticketed.tickets.length, 1, "tickets come from the issue requirement without a model run");
});

test("Python projects run pytest on the changed test files", () => {
  const root = tempDir("ai-harness-py-");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='x'\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "test_parse.py"), "def test_x():\n    assert True\n");
  const command = detectTestCommand(root, ["src/parse.py", "tests/test_parse.py"]);
  assert.equal(command?.args.slice(0, 3).join(" "), "-m pytest -q");
  assert.ok(command?.args.includes("tests/test_parse.py"));
  assert.equal(detectTestCommand(root, ["src/parse.py"])?.args.includes("tests/test_parse.py"), false, "no changed tests runs the suite");
});

test("Go, Rust, and make projects get their own runner; unknown projects get none", () => {
  const go = tempDir("ai-harness-go-");
  fs.writeFileSync(path.join(go, "go.mod"), "module x\n");
  assert.deepEqual(detectTestCommand(go, ["pkg/a/a.go"])?.args, ["test", "./pkg/a"]);
  const rust = tempDir("ai-harness-rs-");
  fs.writeFileSync(path.join(rust, "Cargo.toml"), "[package]\n");
  assert.equal(detectTestCommand(rust, [])?.label, "cargo test");
  const made = tempDir("ai-harness-make-");
  fs.writeFileSync(path.join(made, "Makefile"), "test:\n\ttrue\n");
  assert.equal(detectTestCommand(made, [])?.label, "make test");
  assert.equal(detectTestCommand(tempDir("ai-harness-none-"), ["README.md"]), null);
});

test("a run that collected no tests is not a pass", () => {
  assert.equal(nonNodeRanTests("collected 0 items\n\nno tests ran in 0.01s"), false);
  assert.equal(nonNodeRanTests("3 passed in 0.12s"), true);
});
