import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { baselineDiagnosis, BmadControlPlane, testPackageDir } from "../plane";
import { buildPackages, describeNpmTests, detectTestCommand, nonNodeRanTests, npmLockRoot, npmTestPackages, npmTestPlan } from "../test-command";

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

/** A workspace monorepo shaped like a typical Express + Next.js repository: tests only in the server package. */
function monorepo(): string {
  const root = tempDir("ai-harness-mono-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mono", private: true, workspaces: ["app/server", "app/web"], scripts: { lint: "eslint ." } }));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.mkdirSync(path.join(root, "app", "server", "tests", "auth"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "server", "package.json"),
    JSON.stringify({ name: "server", type: "module", scripts: { test: "node --experimental-vm-modules ../../node_modules/.bin/jest" }, devDependencies: { jest: "^30.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "app", "server", "tests", "auth", "me.test.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(root, "app", "server", "jest.config.ts"), 'import type { Config } from "jest";\nconst config: Config = {};\nexport default config;\n');
  fs.mkdirSync(path.join(root, "app", "web", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "web", "package.json"), JSON.stringify({ name: "web", scripts: { dev: "next dev" } }));
  return root;
}

test("a monorepo without a root test script runs the workspace that has tests, whichever package changed", () => {
  const root = monorepo();
  assert.deepEqual(npmTestPackages(root), ["app/server"]);
  const server = path.join(root, "app", "server");
  for (const changed of [["app/server/src/app.ts"], ["app/web/app/page.tsx"], ["app/server/src/app.ts", "app/web/app/page.tsx"]]) {
    const plan = npmTestPlan(root, changed, testPackageDir(root, changed));
    assert.equal(plan?.dir, server, changed.join(" + "));
    assert.equal(plan?.label, "npm test (in app/server)");
  }
  fs.writeFileSync(path.join(root, "app", "web", "package.json"), JSON.stringify({ name: "web", scripts: { test: "vitest run" } }));
  const both = ["app/server/src/app.ts", "app/web/app/page.tsx"];
  assert.deepEqual(npmTestPlan(root, both, testPackageDir(root, both))?.args, ["test", "--workspaces", "--if-present"]);
  assert.equal(npmTestPlan(root, ["app/web/app/page.tsx"], testPackageDir(root, ["app/web/app/page.tsx"]))?.label, "npm test (in app/web)");
  assert.equal(npmTestPlan(tempDir("ai-harness-empty-"), [], tempDir("ai-harness-empty-")), null);
});

test("the build prompt names the workspace test setup instead of asking for a new package.json", () => {
  const root = monorepo();
  const described = describeNpmTests(root) ?? "";
  assert.match(described, /app\/server: `npm test` runs `node --experimental-vm-modules \.\.\/\.\.\/node_modules\/\.bin\/jest` \(Jest\)/);
  assert.match(described, /existing tests: app\/server\/tests\/auth\/me\.test\.ts/);
  assert.match(described, /Do not add a test script to the root package\.json/);
  const plane = new BmadControlPlane(root);
  const instruction = (plane as unknown as { testInstruction(): string }).testInstruction();
  assert.equal(instruction, described);
  assert.doesNotMatch(instruction, /Add a package\.json whose test script/);
});

test("the workspace lockfile governs a member package", () => {
  const root = monorepo();
  assert.equal(npmLockRoot(root, path.join(root, "app", "server")), root);
  const bare = tempDir("ai-harness-nolock-");
  assert.equal(npmLockRoot(bare, bare), null);
});

test("a baseline Jest failure on a TypeScript config names the fix", () => {
  const root = monorepo();
  const server = path.join(root, "app", "server");
  const output = "Error: Jest: Failed to parse the TypeScript config file app/server/jest.config.ts\n  Error: Jest: 'ts-node' is required for the TypeScript configuration files. Make sure it is installed\n";
  const hints = baselineDiagnosis(output, server, root);
  assert.equal(hints.length, 1);
  assert.match(hints[0] ?? "", /rename it to app\/server\/jest\.config\.js/);
  assert.match(hints[0] ?? "", /keep `export default config;`/);
  assert.match(hints[0] ?? "", /Do not add ts-node/);
  assert.match(hints[0] ?? "", /then delete app\/server\/jest\.config\.ts\. Jest refuses to run while both files exist/, "a model told only to rename leaves both files");
  fs.writeFileSync(path.join(server, "jest.config.js"), "export default {};\n");
  const both = baselineDiagnosis("● Multiple configurations found:\n    * app/server/jest.config.ts\n    * app/server/jest.config.js", server, root);
  assert.equal(both.length, 1);
  assert.match(both[0] ?? "", /more than one config file \(app\/server\/jest\.config\.ts, app\/server\/jest\.config\.js\)/);
  assert.match(both[0] ?? "", /keep app\/server\/jest\.config\.js and delete the others; the \.ts one needs ts-node/);
  assert.match(baselineDiagnosis("Cannot find module 'supertest' from 'tests/a.test.ts'", server, root)[0] ?? "", /add it to devDependencies of app\/server\/package\.json/);
  assert.deepEqual(baselineDiagnosis("Tests: 3 failed", server, root), []);
});

test("a failing baseline is reported with its output and logged; a passing one adds nothing", () => {
  const root = monorepo();
  for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(root, `f${index}.md`), "x");
  let testOutput = { exitCode: 1, stdout: "", stderr: "Error: Jest: 'ts-node' is required for the TypeScript configuration files." };
  const calls: string[][] = [];
  const plane = new BmadControlPlane(root, {
    runner: {
      which: () => "/usr/bin/npm",
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "git") return { exitCode: 0, stdout: "a\nb\nc\nd\ne\n", stderr: "", durationMs: 1, timedOut: false };
        if (args[0] === "ci") return { exitCode: 0, stdout: "added 10 packages", stderr: "", durationMs: 1, timedOut: false };
        return { ...testOutput, durationMs: 1, timedOut: false };
      },
    },
  });
  const mission = plane.createMission("Resolve GitHub issue o/r#1: duplicate a workflow", { issue: { title: "o/r#1 duplicate", acceptance: "A workflow can be duplicated." } });
  const baseline = (plane as unknown as { baselineTests(mission: unknown, ref: string, worktree: string): string | null }).baselineTests.bind(plane);
  const note = baseline(mission, "1.1", root) ?? "";
  assert.match(note, /Before any change, `npm test \(in app\/server\)` already fails/);
  assert.match(note, /ts-node' is required/);
  assert.match(note, /rename it to app\/server\/jest\.config\.js/);
  assert.ok(calls.some((call) => call.join(" ") === "npm ci --ignore-scripts --no-audit --no-fund"), "installs from the root lockfile");
  const retry = (plane as unknown as { retryContext(mission: unknown, ref: string, earlier: string[]): string }).retryContext.bind(plane);
  const resumed = retry(mission, "1.1", ["app/server/jest.config.js"]);
  assert.ok(resumed.startsWith(note), "a retry on a dirty worktree still carries the baseline failure");
  assert.match(resumed, /left these changes in the worktree: app\/server\/jest\.config\.js/);
  assert.match(resumed, /fixing the test setup alone does not implement it/);
  const failed = (plane as unknown as { baselineFailed(mission: unknown, ref: string): boolean }).baselineFailed.bind(plane);
  assert.equal(failed(mission, "1.1"), true, "the reviewer is told the setup fix is in scope");
  testOutput = { exitCode: 0, stdout: "", stderr: "Tests: 48 passed, 48 total" };
  assert.equal(baseline(mission, "1.1", root), null);
  assert.equal(failed(mission, "1.1"), false);
  assert.doesNotMatch(retry(mission, "1.1", ["a.ts"]), /already fails/, "a passing baseline leaves no stale note");
});

test("a lockfile install falls back to a lockless install when the change added a dependency", () => {
  const root = monorepo();
  const calls: string[][] = [];
  const plane = new BmadControlPlane(root, {
    runner: {
      which: () => "/usr/bin/npm",
      run: (command: string, args: string[], cwd: string) => {
        calls.push([cwd, command, ...args]);
        return args[0] === "ci" ? { exitCode: 1, stdout: "", stderr: "npm ci can only install packages when your package.json and package-lock.json are in sync", durationMs: 1, timedOut: false } : { exitCode: 0, stdout: "added 1 package", stderr: "", durationMs: 1, timedOut: false };
      },
    },
  });
  const install = (plane as unknown as { installDependencies(dir: string, worktree?: string): string | null }).installDependencies.bind(plane);
  const log = install(path.join(root, "app", "server"), root) ?? "";
  assert.deepEqual(calls.map((call) => call.slice(1, 3).join(" ")), ["npm ci", "npm install"]);
  assert.ok(calls.every((call) => call[0] === root), "both run at the lockfile root");
  assert.ok(calls[1]?.includes("--no-package-lock"), "the fallback does not rewrite the lockfile");
  assert.match(log, /in sync[\s\S]*install exit 1[\s\S]*added 1 package[\s\S]*install exit 0/);
});

/** A real git repository shaped like the monorepo above, with a web package whose build rewrites a tracked file. */
function gitMonorepo(): string {
  const root = monorepo();
  fs.writeFileSync(path.join(root, "app", "web", "package.json"), JSON.stringify({ name: "web", scripts: { build: "next build" } }));
  fs.writeFileSync(path.join(root, "app", "server", "package.json"), JSON.stringify({ name: "server", scripts: { test: "jest", build: "tsc -p tsconfig.build.json" } }));
  fs.writeFileSync(path.join(root, "app", "web", "next-env.d.ts"), "/// <reference types=\"next\" />\n");
  fs.writeFileSync(path.join(root, "app", "web", "app", "page.tsx"), "export default function Page() { return null; }\n");
  const git = (...args: string[]) => childProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

function realGitRunner(npm: (args: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      which: () => "/usr/bin/npm",
      run: (command: string, args: string[], cwd: string) => {
        if (command === "git") {
          const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
          return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, durationMs: 1, timedOut: false };
        }
        calls.push(`${path.relative(cwd.includes("app") ? path.resolve(cwd, "../..") : cwd, cwd) || "."}: ${command} ${args.join(" ")}`);
        return { ...npm(args, cwd), durationMs: 1, timedOut: false };
      },
    },
  };
}

test("the packages a change touches are built after their tests, never the workspace root", () => {
  const root = gitMonorepo();
  assert.deepEqual(buildPackages(root, ["app/web/app/page.tsx"]), ["app/web"]);
  assert.deepEqual(buildPackages(root, ["app/server/src/app.ts", "app/web/app/page.tsx", "README.md"]), ["app/server", "app/web"]);
  assert.deepEqual(buildPackages(root, ["README.md"]), [], "the root only lists workspaces");
});

test("a build that fails fails verification even when the tests pass, and a build's rewrite of a tracked file is undone", () => {
  const root = gitMonorepo();
  fs.writeFileSync(path.join(root, "app", "web", "app", "page.tsx"), "export default function Page() { return <Missing />; }\n");
  let buildFails = true;
  const { runner, calls } = realGitRunner((args, cwd) => {
    if (args[0] === "run" && args[1] === "build" && cwd.endsWith(path.join("app", "web"))) {
      fs.writeFileSync(path.join(cwd, "next-env.d.ts"), "/// <reference types=\"next\" />\n// regenerated\n");
      fs.writeFileSync(path.join(cwd, "app", "page.tsx"), "tampered by the build");
      return buildFails ? { exitCode: 1, stdout: "", stderr: "Type error: Cannot find name 'Missing'." } : { exitCode: 0, stdout: "Compiled successfully", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "Tests: 48 passed, 48 total" };
  });
  const plane = new BmadControlPlane(root, { runner });
  const builds = (plane as unknown as { runBuilds(worktree: string, changed: string[]): Array<{ label: string; ok: boolean; output: string }> }).runBuilds.bind(plane);
  const failed = builds(root, ["app/web/app/page.tsx"]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.label, "npm run build (in app/web)");
  assert.equal(failed[0]?.ok, false);
  assert.match(failed[0]?.output ?? "", /Cannot find name 'Missing'/);
  assert.equal(fs.readFileSync(path.join(root, "app", "web", "next-env.d.ts"), "utf8"), "/// <reference types=\"next\" />\n", "a tracked file the build rewrote is back at HEAD");
  assert.match(fs.readFileSync(path.join(root, "app", "web", "app", "page.tsx"), "utf8"), /<Missing \/>/, "the agent's own change is kept");
  assert.deepEqual(calls, ["app/web: npm run build"]);
  buildFails = false;
  assert.equal(builds(root, ["app/web/app/page.tsx"])[0]?.ok, true);
});

test("a planning step that times out on every attempt stops as provider blocked instead of asking for another pass", async () => {
  const plane = new BmadControlPlane(tempDir("ai-harness-provider-"));
  const mission = plane.createMission("Resolve GitHub issue o/r#26: duplicate a workflow", { issue: { title: "o/r#26 duplicate", acceptance: "A workflow can be duplicated." } });
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 200 } });
  const lines: string[] = [];
  const result = await plane.autopilot(mission.id, { log: (line) => lines.push(line) });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /^Provider blocked: bmad-spec timed out on all 3 attempts/);
  assert.doesNotMatch(result.reason, /did not complete/, "the harness session resumes only on a missed contract");
  assert.equal(lines.filter((line) => /^Running bmad-spec/.test(line)).length, 3, "the configured three attempts still run");
});

test("a planning step that answers but misses its contract still reports did not complete", async () => {
  const plane = new BmadControlPlane(tempDir("ai-harness-contract-"));
  const mission = plane.createMission("Resolve GitHub issue o/r#26: duplicate a workflow", { issue: { title: "o/r#26 duplicate", acceptance: "A workflow can be duplicated." } });
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "process.stdout.write('done, I think')"], timeoutMs: 20000 } });
  const result = await plane.autopilot(mission.id, { log: () => undefined });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /bmad-spec did not complete/);
});
