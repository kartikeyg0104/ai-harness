import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DeterministicBrowser, browserNavigationAllowed, scenarioFromCriterion } from "../browser";
import * as api from "../index";
import { BmadControlPlane } from "../plane";
import { renderMissionControl } from "../render";
import type { BrowserScenario } from "../browser";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-browser-"));
}

function answerAll(plane: BmadControlPlane, id: string): void {
  let mission = plane.mission(id);
  while (mission.forge && mission.forge.outcome === "active") {
    const open = mission.forge.questions.find((question) => !mission.forge?.answered.includes(question.id));
    if (!open) break;
    mission = plane.answerForge(id, `locked answer for ${open.id}`);
  }
}

function missionWithRequirement(idea: string, browser?: DeterministicBrowser): { root: string; plane: BmadControlPlane; id: string } {
  const root = tempProject();
  const plane = new BmadControlPlane(root, browser ? { browser } : {});
  const mission = plane.createMission(idea);
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  return { root, plane, id: mission.id };
}

function scenario(startUrl: string, overrides: Partial<BrowserScenario> = {}): BrowserScenario {
  return {
    id: "BROWSER-REQ-001",
    requirementId: "REQ-001",
    name: "Health page",
    startUrl,
    steps: [
      { action: "navigate", target: startUrl, name: "open" },
      { action: "click", target: "#check", name: "check" },
    ],
    assertions: [
      { kind: "visible", target: "#status", expected: "visible" },
      { kind: "text", target: "#error", expected: "invalid health input" },
    ],
    ...overrides,
  };
}

function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const HEALTH_PAGE = `<!doctype html><html><body>
<p id="status">Health: ok</p>
<button id="check">Check</button>
<p id="error" hidden>invalid health input</p>
<script>
document.getElementById("check").addEventListener("click", () => {
  document.getElementById("error").hidden = false;
  console.log("health-page");
});
</script>
</body></html>`;

test("browser navigation stays inside configured origins", () => {
  assert.equal(browserNavigationAllowed("http://127.0.0.1:4311/", ["http://127.0.0.1", "http://localhost"], "assist").allowed, true);
  assert.equal(browserNavigationAllowed("https://example.com/", ["http://127.0.0.1", "http://localhost"], "assist").allowed, false);
  assert.equal(browserNavigationAllowed("file:///tmp/page.html", ["http://127.0.0.1"], "assist").allowed, false);
  assert.equal(browserNavigationAllowed("http://127.0.0.1/", [], "assist").allowed, false);
  assert.equal(browserNavigationAllowed("http://127.0.0.1/", ["http://127.0.0.1"], "observe").allowed, false);
});

test("acceptance criteria become browser scenarios only when an assertion exists", () => {
  const generated = scenarioFromCriterion("REQ-001", "User can create an expense.", "http://127.0.0.1:3000/");
  assert.equal(generated?.requirementId, "REQ-001");
  assert.equal(generated?.id, "BROWSER-REQ-001");
  assert.equal(generated?.steps.some((step) => step.action === "click" && step.target === "text=Add Expense"), true);
  assert.equal(generated?.assertions.some((assertion) => assertion.expected === "12.00"), true);
  assert.equal(scenarioFromCriterion("REQ-001", "the page loads", "http://127.0.0.1:3000/"), null);
});

test("a browser scenario must belong to a requirement", () => {
  const { plane, id } = missionWithRequirement("Add a health page.");
  assert.throws(() => plane.registerBrowserScenario(id, scenario("http://127.0.0.1/", { requirementId: "REQ-404", id: "BROWSER-REQ-404" })), /not linked to a requirement/);
});

test("browser unavailable does not start and cannot pass", async () => {
  const browser = new DeterministicBrowser("unavailable");
  const { root, plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id, "REQ-001");
  assert.equal(result.status, "NOT_CONFIGURED");
  assert.equal(browser.calls, 0);
  const events = fs.readFileSync(eventPath(root, id), "utf8");
  assert.equal(events.includes("BrowserStarted"), false);
  assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "browser")?.result, "pass");
});

test("browser launch failure is not a pass", async () => {
  const browser = new DeterministicBrowser("launch-error");
  const { root, plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id, "BROWSER-REQ-001");
  assert.equal(result.status, "ERROR");
  assert.match(result.summary, /launch failed/);
  const events = fs.readFileSync(eventPath(root, id), "utf8");
  assert.equal(events.includes("BrowserStarted"), true);
  assert.equal(events.includes("BrowserFailed"), true);
  assert.equal(events.includes("BrowserCompleted"), false);
  assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "browser")?.result, "pass");
});

test("browser timeout stays failed and keeps the evidence file", async () => {
  const browser = new DeterministicBrowser("timeout");
  const { root, plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id, "BROWSER-REQ-001");
  assert.equal(result.status, "TIMEOUT");
  assert.match(result.summary, /not a pass/);
  const evidence = plane.mission(id).evidence.find((record) => record.kind === "browser");
  assert.equal(evidence?.result, "fail");
  assert.equal(evidence?.artifact ? fs.existsSync(evidence.artifact) : false, true);
  const events = fs.readFileSync(eventPath(root, id), "utf8");
  assert.equal(events.includes("BrowserCompleted"), false);
});

test("browser assertion failure cannot pass", async () => {
  const browser = new DeterministicBrowser("assertion-fail");
  const { plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id);
  assert.equal(result.status, "FAIL");
  assert.equal(plane.mission(id).evidence.find((record) => record.kind === "browser")?.result, "fail");
});

test("a test-only browser pass without screenshots is rejected", async () => {
  const browser = new DeterministicBrowser("pass");
  const { plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id);
  assert.notEqual(result.status, "PASS");
  assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "browser")?.result, "pass");
});

test("invalid scenarios and outside origins do not launch", async () => {
  const browser = new DeterministicBrowser("pass");
  const { plane, id } = missionWithRequirement("Add a health page.", browser);
  plane.registerBrowserScenario(id, scenario("https://example.com/"));
  const outside = await plane.runBrowser(id);
  assert.equal(outside.status, "ERROR");
  assert.equal(browser.calls, 0);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/", { id: "BROWSER-EMPTY", assertions: [] }));
  const invalid = await plane.runBrowser(id, "BROWSER-EMPTY");
  assert.equal(invalid.status, "ERROR");
  assert.equal(browser.calls, 0);
});

test("an unresolved attack blocks the browser", async () => {
  const browser = new DeterministicBrowser("pass");
  const { root, plane, id } = missionWithRequirement("Build an expense-management SaaS.", browser);
  plane.registerBrowserScenario(id, scenario("http://127.0.0.1/"));
  const result = await plane.runBrowser(id);
  assert.equal(result.status, "ERROR");
  assert.match(result.summary, /attack/i);
  assert.equal(browser.calls, 0);
  assert.equal(fs.readFileSync(eventPath(root, id), "utf8").includes("BrowserStarted"), false);
});

test("missing browser evidence blocks a critical release", () => {
  const { plane, id } = missionWithRequirement("Build an expense-management SaaS.");
  const report = plane.releaseGate(id);
  assert.notEqual(report.state, "pass");
  assert.equal(report.criteria.find((item) => item.id === "browser")?.state, "blocked");
  assert.equal(report.lastVerifiedBuild, null);
});

test("@bmad attack, browser, and verify use the control plane", async () => {
  const { plane, id } = missionWithRequirement("Add a health page.");
  const attack = plane.handleIntent("@bmad attack", id);
  assert.equal(attack.name, "attack");
  assert.equal((attack.detail as { status?: string }).status, "NOT_CONFIGURED");
  const browser = plane.handleIntent("@bmad run browser", id);
  assert.equal(browser.name, "browser");
  assert.equal(((await browser.detail) as { status?: string }).status, "NOT_CONFIGURED");
  const verified = plane.handleIntent("@bmad verify REQ-001", id);
  assert.equal(verified.name, "verify");
  assert.equal(verified.target, "REQ-001");
  assert.equal(((await verified.detail) as { browser: { status: string } }).browser.status, "NOT_CONFIGURED");
  assert.equal((api as { DeterministicBrowser?: unknown }).DeterministicBrowser, undefined);
  assert.equal(typeof api.PlaywrightBrowser, "function");
});

test("a real Playwright scenario passes only with screenshots and leaves release blocked", { timeout: 60000 }, async () => {
  const { root, plane, id } = missionWithRequirement("Add a health page.");
  const page = await serve(HEALTH_PAGE);
  try {
    plane.registerBrowserScenario(id, scenario(page.url));
    const result = await plane.runBrowser(id, "REQ-001");
    assert.equal(result.status, "PASS", result.summary);
    assert.equal(result.readiness.packageInstalled, true);
    assert.equal(result.readiness.binaryInstalled, true);
    assert.equal(result.readiness.launched, true);
    assert.equal(result.readiness.executed, true);
    assert.equal(result.readiness.passed, true);
    assert.equal(result.requirementId, "REQ-001");
    for (const name of ["start", "action", "final"]) {
      const shot = result.screenshots.find((item) => item.name === name);
      assert.equal(shot ? fs.existsSync(shot.path) && fs.statSync(shot.path).size > 0 : false, true);
    }
    const evidence = plane.mission(id).evidence.find((record) => record.kind === "browser");
    assert.equal(evidence?.result, "pass");
    assert.equal(evidence?.requirement_id, "REQ-001");
    assert.equal(evidence?.exit_code, 0);
    const stored = JSON.parse(fs.readFileSync(evidence?.artifact ?? "", "utf8")) as { browserVersion: string; viewport: { width: number }; consoleLogs: string[]; url: string };
    assert.equal(typeof stored.browserVersion, "string");
    assert.equal(stored.viewport.width, 1280);
    assert.match(stored.consoleLogs.join("\n"), /health-page/);
    const events = fs.readFileSync(eventPath(root, id), "utf8");
    assert.equal(events.includes("BrowserStarted"), true);
    assert.equal(events.includes("BrowserStepCompleted"), true);
    assert.equal(events.includes("BrowserCompleted"), true);
    const report = plane.releaseGate(id);
    assert.notEqual(report.state, "pass");
    assert.equal(report.lastVerifiedBuild, null);
    const pageHtml = renderMissionControl(plane.mission(id));
    assert.match(pageHtml, /BROWSER ✅/);
    assert.match(pageHtml, /RELEASE 🔒/);
    assert.match(pageHtml, /REQ-001/);
    assert.match(pageHtml, /Browser ✅/);
  } finally {
    await page.close();
  }
});

test("a real Playwright assertion failure and a closed port do not pass", { timeout: 60000 }, async () => {
  const { plane, id } = missionWithRequirement("Add a health page.");
  const page = await serve("<!doctype html><html><body><p id='status'>Hello</p></body></html>");
  try {
    plane.registerBrowserScenario(id, scenario(page.url, { steps: [{ action: "navigate", target: page.url, name: "open" }], assertions: [{ kind: "text", target: "#status", expected: "not-on-page" }] }));
    const failed = await plane.runBrowser(id);
    assert.equal(failed.status, "FAIL");
    assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "browser")?.result, "pass");
    plane.registerBrowserScenario(id, scenario("http://127.0.0.1:1/", { id: "BROWSER-DOWN", steps: [{ action: "navigate", target: "http://127.0.0.1:1/", name: "open" }], assertions: [{ kind: "text", target: "body", expected: "up" }] }));
    const down = await plane.runBrowser(id, "BROWSER-DOWN");
    assert.notEqual(down.status, "PASS");
    assert.ok(down.status === "FAIL" || down.status === "ERROR" || down.status === "TIMEOUT");
  } finally {
    await page.close();
  }
});

function eventPath(root: string, missionId: string): string {
  return path.join(root, ".bmad-next", "missions", missionId, "events.jsonl");
}

