import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyHarnessEnv, harnessOpenCodeConfig, loadHarnessConfig } from "../harness-config";

function tempRoot(config?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-config-"));
  if (config) fs.writeFileSync(path.join(root, "harness.config.json"), JSON.stringify(config));
  return root;
}

test("the committed harness.config.json defines a text model and no credential", () => {
  const file = path.resolve(__dirname, "..", "..", "..", "..", "harness.config.json");
  const raw = fs.readFileSync(file, "utf8");
  const config = loadHarnessConfig(path.dirname(file), {});
  assert.ok(config.provider && config.model);
  assert.doesNotMatch(raw, /apiKey|api_key|secret|token|nvapi-|sk-/i);
});

test("AI_PROVIDER, AI_MODEL, and AI_BASE_URL override the file without editing it", () => {
  const root = tempRoot({ provider: "nvidia", model: "openai/gpt-oss-20b" });
  const config = loadHarnessConfig(root, { AI_PROVIDER: "openai", AI_MODEL: "gpt-5", AI_BASE_URL: "https://gateway.example/v1" });
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-5");
  assert.equal(config.baseURL, "https://gateway.example/v1");
});

test("an OpenAI-compatible provider needs a base URL", () => {
  const root = tempRoot({ provider: "openai-compatible", model: "m" });
  assert.throws(() => loadHarnessConfig(root, {}), /baseURL/);
  const config = loadHarnessConfig(root, { AI_BASE_URL: "https://gateway.example/v1" });
  const provider = (harnessOpenCodeConfig(config, true).provider as Record<string, Record<string, unknown>>)["openai-compatible"];
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(provider.models, { m: { name: "m" } });
});

test("AI_API_KEY reaches OpenCode as an env reference and is never written to disk", () => {
  const root = tempRoot({ provider: "nvidia", model: "openai/gpt-oss-20b" });
  const secret = "test-credential-value-12345";
  const env: NodeJS.ProcessEnv = { AI_API_KEY: secret };
  applyHarnessEnv(root, loadHarnessConfig(root, env), env);
  const written = fs.readFileSync(env.OPENCODE_CONFIG ?? "", "utf8");
  assert.ok(!written.includes(secret));
  const parsed = JSON.parse(written) as { model: string; provider: { nvidia: { options: { apiKey: string } } } };
  assert.equal(parsed.provider.nvidia.options.apiKey, "{env:AI_API_KEY}");
  assert.equal(parsed.model, "nvidia/openai/gpt-oss-20b");
  assert.equal(env.BMAD_RUNTIME, "opencode");
  assert.equal(env.BMAD_MODEL, "nvidia/openai/gpt-oss-20b");
  assert.ok(JSON.parse(env.BMAD_REVIEWER_ARGS ?? "[]").includes("plan"), "the reviewer runs read-only");
  assert.ok(!Object.entries(env).some(([key, value]) => key !== "AI_API_KEY" && value?.includes(secret)));
});

test("without AI_API_KEY the generated config sends no empty key", () => {
  const root = tempRoot();
  const env: NodeJS.ProcessEnv = {};
  applyHarnessEnv(root, loadHarnessConfig(root, env), env);
  const parsed = JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG ?? "", "utf8")) as { provider: Record<string, { options: Record<string, unknown> }> };
  assert.equal(Object.values(parsed.provider)[0].options.apiKey, undefined);
});
