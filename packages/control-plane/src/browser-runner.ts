import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { BrowserAssertion, BrowserResult, BrowserScenario, BrowserStep } from "./browser";

const nodeRequire = createRequire(__filename);

interface Payload {
  scenario: BrowserScenario;
  evidenceDir: string;
  timeoutMs: number;
  viewport: { width: number; height: number };
  signal?: Int32Array;
}

interface PageLike {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<unknown>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  screenshot(options: { path: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    waitFor(options: { state: "visible"; timeout: number }): Promise<unknown>;
    innerText(options: { timeout: number }): Promise<string>;
    getAttribute(name: string): Promise<string | null>;
    count(): Promise<number>;
  };
  url(): string;
  getByRole?(role: "button" | "link", options: { name: string }): { count(): Promise<number>; click(options: { timeout: number }): Promise<unknown> };
  evaluate?<T>(expression: string): Promise<T>;
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "requestfailed", handler: (request: { url(): string; failure(): { errorText: string } | null }) => void): void;
}

function publish(payload: Payload, result: BrowserResult): void {
  fs.mkdirSync(payload.evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(payload.evidenceDir, "result.json"), JSON.stringify(result));
  if (payload.signal) {
    Atomics.store(payload.signal, 0, 1);
    Atomics.notify(payload.signal, 0);
  }
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(0, "utf8");
  const payload = JSON.parse(raw) as Payload;
  const startedAt = new Date().toISOString();
  const result = await executeBrowserScenario(payload, startedAt);
  publish(payload, result);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.status === "PASS" ? 0 : result.status === "TIMEOUT" ? 2 : 1);
}

/** A worker started for a browser scenario. Other workers load this module too (the editor's control-plane worker). */
function isBrowserPayload(data: unknown): data is Payload {
  const scenario = (data as { scenario?: { id?: unknown } } | null)?.scenario;
  return typeof scenario === "object" && scenario !== null && typeof scenario.id === "string";
}

if (!isMainThread && parentPort && isBrowserPayload(workerData)) {
  const payload = workerData;
  void executeBrowserScenario(payload, new Date().toISOString())
    .then((result) => {
      publish(payload, result);
      parentPort?.postMessage({ status: result.status });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const failed: BrowserResult = {
        status: "ERROR",
        summary: message,
        readiness: { packageInstalled: true, binaryInstalled: true, launched: false, executed: false, passed: false },
        scenarioId: payload.scenario.id,
        requirementId: payload.scenario.requirementId,
        browser: "chromium",
        browserVersion: null,
        url: payload.scenario.startUrl,
        viewport: payload.viewport,
        steps: [],
        assertions: [],
        screenshots: [],
        consoleLogs: [],
        networkErrors: [],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      };
      publish(payload, failed);
      parentPort?.postMessage({ status: "ERROR" });
    });
}

export async function executeBrowserScenario(payload: Payload, startedAt: string): Promise<BrowserResult> {
  const { scenario, evidenceDir, timeoutMs, viewport } = payload;
  const base: BrowserResult = {
    status: "ERROR",
    summary: "",
    readiness: { packageInstalled: true, binaryInstalled: true, launched: false, executed: false, passed: false },
    scenarioId: scenario.id,
    requirementId: scenario.requirementId,
    browser: "chromium",
    browserVersion: null,
    url: scenario.startUrl,
    viewport,
    steps: [],
    assertions: [],
    screenshots: [],
    consoleLogs: [],
    networkErrors: [],
    startedAt,
    endedAt: startedAt,
  };
  let browser: { version(): string; close(): Promise<void>; newPage(options: { viewport: { width: number; height: number } }): Promise<PageLike> } | null = null;
  try {
    const loaded = nodeRequire("playwright") as { chromium: { launch(options: { timeout: number }): Promise<NonNullable<typeof browser>> } };
    browser = await loaded.chromium.launch({ timeout: Math.min(timeoutMs, 15000) });
    base.readiness.launched = true;
    base.browserVersion = browser.version();
    const page = await browser.newPage({ viewport });
    page.on("console", (message) => {
      if (base.consoleLogs.length < 50) base.consoleLogs.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      if (base.networkErrors.length < 50) base.networkErrors.push(error.message);
    });
    page.on("requestfailed", (request) => {
      if (base.networkErrors.length < 50) base.networkErrors.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    });
    const stepTimeout = Math.min(timeoutMs, 10000);
    let sawAction = false;
    for (const step of scenario.steps) {
      const at = new Date().toISOString();
      try {
        const healed = await runStep(page, step, stepTimeout);
        base.steps.push({ action: step.action, name: step.name ?? step.action, status: healed ? "healed" : "completed", at });
        if (step.action === "navigate" && !base.screenshots.some((shot) => shot.name === "start")) {
          base.screenshots.push(await shoot(page, evidenceDir, "start"));
        }
        if ((step.action === "click" || step.action === "fill" || step.action === "select") && !sawAction) {
          base.screenshots.push(await shoot(page, evidenceDir, "action"));
          sawAction = true;
        }
        if (step.action === "screenshot") {
          base.screenshots.push(await shoot(page, evidenceDir, step.name ?? `shot-${base.screenshots.length + 1}`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        base.steps.push({ action: step.action, name: step.name ?? step.action, status: "failed", at });
        base.endedAt = new Date().toISOString();
        base.readiness.executed = true;
        if (step.action === "navigate" && /timeout/i.test(message)) {
          base.status = "TIMEOUT";
          base.summary = `Browser step timed out: ${message}`;
        } else if (/timeout/i.test(message)) {
          base.status = "FAIL";
          base.summary = `element not found: ${message}`;
        } else if (/ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|unable to connect/i.test(message)) {
          base.status = "ERROR";
          base.summary = `Application unavailable: ${message}`;
        } else {
          base.status = "FAIL";
          base.summary = message;
        }
        try {
          base.screenshots.push(await shoot(page, evidenceDir, "final"));
        } catch {
          // A failed page may not produce a final image. The status stays failed.
        }
        return base;
      }
    }
    base.readiness.executed = true;
    base.url = page.url();
    for (const assertion of scenario.assertions) {
      const checked = await checkAssertion(page, assertion, stepTimeout);
      base.assertions.push(checked);
    }
    base.screenshots.push(await shoot(page, evidenceDir, "final"));
    base.endedAt = new Date().toISOString();
    if (base.assertions.some((assertion) => assertion.status === "FAIL")) {
      base.status = "FAIL";
      base.summary = "A browser assertion failed.";
      return base;
    }
    base.status = "PASS";
    base.summary = "Browser scenario passed.";
    base.readiness.passed = true;
    return base;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    base.endedAt = new Date().toISOString();
    base.status = /timeout/i.test(message) ? "TIMEOUT" : "ERROR";
    base.summary = base.readiness.launched ? message : `Browser launch failed: ${message}`;
    base.readiness.passed = false;
    return base;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

async function runStep(page: PageLike, step: BrowserStep, timeout: number): Promise<boolean> {
  const target = step.target ?? "";
  if (step.action === "navigate") {
    await page.goto(target, { timeout, waitUntil: "domcontentloaded" });
    return false;
  }
  if (step.action === "click") {
    try {
      await page.click(target, { timeout });
      return false;
    } catch (error) {
      if (!step.name || !page.getByRole) throw error;
      const locator = page.getByRole("button", { name: step.name });
      if ((await locator.count()) !== 1) throw error;
      await locator.click({ timeout });
      return true;
    }
  }
  else if (step.action === "fill") await page.fill(target, step.value ?? "", { timeout });
  else if (step.action === "select") await page.selectOption(target, step.value ?? "", { timeout });
  else if (step.action === "wait") {
    if (/^\d+$/.test(target)) await new Promise((resolve) => setTimeout(resolve, Number(target)));
    else await page.waitForSelector(target, { timeout });
  }
  return false;
}

export async function captureViewports(url: string, evidenceDir: string): Promise<{ viewports: Array<{ name: string; width: number; height: number; path: string; overflow: boolean }>; status: "PASS" | "FAIL" | "NOT_CONFIGURED" }> {
  fs.mkdirSync(evidenceDir, { recursive: true });
  let browser: { close(): Promise<void>; newPage(): Promise<PageLike> } | null = null;
  try {
    const loaded = nodeRequire("playwright") as { chromium: { launch(options: { timeout: number }): Promise<NonNullable<typeof browser>> } };
    browser = await loaded.chromium.launch({ timeout: 15000 });
  } catch {
    return { viewports: [], status: "NOT_CONFIGURED" };
  }
  const sizes = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
  ];
  const viewports: Array<{ name: string; width: number; height: number; path: string; overflow: boolean }> = [];
  try {
    const page = await browser.newPage();
    for (const size of sizes) {
      if (page.setViewportSize) await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(url, { timeout: 10000, waitUntil: "domcontentloaded" });
      const metrics = page.evaluate
        ? await page.evaluate<{ scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }>("({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight })")
        : { scrollWidth: size.width, clientWidth: size.width, scrollHeight: size.height, clientHeight: size.height };
      const shot = path.join(evidenceDir, `${size.name}.png`);
      await page.screenshot({ path: shot, timeout: 5000 });
      viewports.push({ ...size, path: shot, overflow: metrics.scrollWidth > metrics.clientWidth + 1 || metrics.scrollHeight > metrics.clientHeight + 1 });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { viewports, status: viewports.some((item) => item.overflow) ? "FAIL" : "PASS" };
}

async function checkAssertion(page: PageLike, assertion: BrowserAssertion, timeout: number): Promise<BrowserResult["assertions"][number]> {
  try {
    if (assertion.kind === "url") {
      const ok = page.url().includes(assertion.expected);
      return { ...assertion, status: ok ? "PASS" : "FAIL", message: page.url() };
    }
    const locator = page.locator(assertion.target);
    if (assertion.kind === "visible") {
      await locator.waitFor({ state: "visible", timeout });
      return { ...assertion, status: "PASS", message: "visible" };
    }
    if (assertion.kind === "text") {
      const text = await locator.innerText({ timeout });
      const ok = text.includes(assertion.expected);
      return { ...assertion, status: ok ? "PASS" : "FAIL", message: text.slice(0, 200) };
    }
    if (assertion.kind === "attribute") {
      const value = await locator.getAttribute(assertion.attribute ?? "");
      const ok = value === assertion.expected;
      return { ...assertion, status: ok ? "PASS" : "FAIL", message: value ?? "missing" };
    }
    const count = await locator.count();
    const ok = String(count) === assertion.expected;
    return { ...assertion, status: ok ? "PASS" : "FAIL", message: String(count) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...assertion, status: "FAIL", message: /timeout/i.test(message) ? `element not found: ${message}` : message };
  }
}

async function shoot(page: PageLike, evidenceDir: string, name: string): Promise<{ name: string; path: string }> {
  const target = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: target, timeout: 5000 });
  return { name, path: target };
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
