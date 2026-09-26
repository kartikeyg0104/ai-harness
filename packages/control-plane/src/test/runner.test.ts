import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processRunner } from "../runner";

test("a spawned process sees PWD equal to its cwd, not the parent's directory", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-pwd-")));
  const result = processRunner.run(process.execPath, ["-e", "process.stdout.write(process.env.PWD ?? '')"], dir, 10000);
  assert.equal(result.stdout, dir);
  const withEnv = processRunner.run(process.execPath, ["-e", "process.stdout.write(process.env.PWD ?? '')"], dir, 10000, { EXTRA: "1" });
  assert.equal(withEnv.stdout, dir);
});
