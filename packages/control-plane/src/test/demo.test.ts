import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorLabel } from "../doctor";
import { assertDemoPath, formatDemoReport, resetDemo } from "../demo";
import type { Mission } from "../types";

test("demo reset deletes only the demo directory and refuses a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-demo-reset-"));
  const userMission = path.join(root, ".bmad-next", "missions", "msn_keep");
  fs.mkdirSync(userMission, { recursive: true });
  fs.writeFileSync(path.join(userMission, "mission.json"), "{}");
  const demo = path.join(root, ".bmad-demo");
  fs.mkdirSync(demo, { recursive: true });
  fs.writeFileSync(path.join(demo, "README.md"), "demo");
  const removed = resetDemo(root);
  assert.equal(fs.existsSync(removed.removed), false);
  assert.equal(fs.existsSync(path.join(userMission, "mission.json")), true);
  assert.throws(() => assertDemoPath(root, path.join(root, ".bmad-next")), /outside \.bmad-demo/);
  fs.mkdirSync(path.dirname(demo), { recursive: true });
  fs.symlinkSync(userMission, demo);
  assert.throws(() => resetDemo(root), /symlink/);
  assert.equal(fs.existsSync(path.join(userMission, "mission.json")), true);
  fs.unlinkSync(demo);
  fs.rmSync(root, { recursive: true, force: true });
});

test("doctor labels availability without calling it a pass", () => {
  assert.equal(doctorLabel("available"), "AVAILABLE");
  assert.equal(doctorLabel("configured"), "CONFIGURED");
  assert.equal(doctorLabel("not-configured"), "NOT_CONFIGURED");
  assert.equal(doctorLabel("not-available"), "NOT_CONFIGURED");
  assert.equal(doctorLabel("blocked"), "FAILED");
  assert.equal(doctorLabel("available") === "AVAILABLE", true);
});

test("demo report reads mission state", () => {
  const mission = {
    id: "msn_demo",
    phase: "build",
    requirements: [{ id: "REQ-001" }],
    tickets: [{ ref: "1.1" }],
    evidence: [{ kind: "unit", result: "fail" }],
    reviews: [{ status: "FAIL" }],
    attacks: [],
    lastVerifiedBuild: null,
  } as unknown as Mission;
  const report = formatDemoReport(mission);
  assert.match(report, /Mission:\nmsn_demo/);
  assert.match(report, /Tests:\nfail/);
  assert.match(report, /Release:\nNOT_RECORDED/);
});
