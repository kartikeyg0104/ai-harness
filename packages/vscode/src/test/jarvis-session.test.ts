import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BmadControlPlane } from "@bmad-next/control-plane";
import { FfmpegMicrophoneInput, GeminiIntentProvider, TextCommandIntentProvider, VoiceError, type AudioClip, type Availability, type VoiceInputProvider, type VoiceIntentProvider, type VoiceOutputProvider } from "../jarvis/providers";
import { JarvisSession, type JarvisHost, type JarvisSnapshot } from "../jarvis/session";

const TODO = "Build a simple todo web app with add, complete, delete, and local persistence.";
const KEY = "AIzaTESTKEY-do-not-leak-0123456789";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "jarvis-session-"));
}

/** Test doubles for devices only. The control plane in these tests is the real one. */
class RecordingOutput implements VoiceOutputProvider {
  readonly id = "test-output";
  spoken: string[] = [];
  stopped = 0;
  private pending: (() => void) | null = null;
  constructor(private readonly mode: "instant" | "hold" | "fail" | "unavailable" = "instant") {}
  availability(): Availability {
    return this.mode === "unavailable" ? { ok: false, reason: "no speaker" } : { ok: true, reason: "test speaker" };
  }
  speak(text: string): Promise<void> {
    this.spoken.push(text);
    if (this.mode === "fail") return Promise.reject(new VoiceError("failed", "speaker broke"));
    if (this.mode === "hold") return new Promise((resolve) => (this.pending = resolve));
    return Promise.resolve();
  }
  stop(): void {
    this.stopped += 1;
    this.pending?.();
    this.pending = null;
  }
}

class ScriptedIntent implements VoiceIntentProvider {
  readonly id = "test-intent";
  constructor(private readonly reply: unknown, private readonly ok = true) {}
  availability(): Availability {
    return this.ok ? { ok: true, reason: "test" } : { ok: false, reason: "GEMINI_API_KEY is not set in the extension host environment." };
  }
  interpretText(text: string): Promise<{ transcript: string; intent: unknown; provider: string }> {
    return Promise.resolve({ transcript: text, intent: this.reply, provider: this.id });
  }
  interpretAudio(): Promise<{ transcript: string; intent: unknown; provider: string }> {
    return Promise.resolve({ transcript: "what are you doing", intent: this.reply, provider: this.id });
  }
}

class NoMicrophone implements VoiceInputProvider {
  readonly id = "none";
  availability(): Availability {
    return { ok: false, reason: "test has no microphone" };
  }
  start(): void {}
  stop(): Promise<AudioClip> {
    return Promise.reject(new VoiceError("failed", "no mic"));
  }
  cancel(): void {}
}

function setup(options: { output?: RecordingOutput; intent?: VoiceIntentProvider; running?: boolean } = {}) {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const calls = { start: 0, stop: 0, evidence: 0 };
  let running = options.running ?? false;
  const host: JarvisHost = {
    root,
    plane: () => plane,
    autopilotRunning: () => running,
    startAutopilot: () => {
      calls.start += 1;
      running = true;
    },
    stopAutopilot: () => {
      calls.stop += 1;
    },
    showEvidence: () => {
      calls.evidence += 1;
    },
  };
  const output = options.output ?? new RecordingOutput();
  const snapshots: JarvisSnapshot[] = [];
  const session = new JarvisSession(
    host,
    { input: new NoMicrophone(), intent: options.intent ?? new ScriptedIntent({ name: "status" }, false), fallback: new TextCommandIntentProvider(), output },
    { narration: "important", voiceOutput: "system", autoListen: "pushToTalk" },
    (snapshot) => snapshots.push(snapshot),
  );
  return { root, plane, session, output, calls, snapshots, setRunning: (value: boolean) => (running = value) };
}

const said = (session: JarvisSession) => session.history.filter((entry) => entry.who === "jarvis").map((entry) => entry.text);

test("activation runs real readiness checks, goes online, and does not start a mission", async () => {
  const { session, plane, calls, output } = setup();
  assert.equal(session.machine.state, "JARVIS_OFF");
  await session.activate();
  await session.flush();
  assert.equal(session.machine.state, "JARVIS_ACTIVE");
  const checks = Object.fromEntries(session.snapshot().readiness.map((check) => [check.label, check.ok]));
  assert.deepEqual(checks, { "Voice input ready": false, "Mission context ready": true, "Event stream connected": true, "Narration ready": true });
  assert.deepEqual(output.spoken, ["Jarvis online."]);
  assert.equal(plane.listMissions().length, 0);
  assert.equal(calls.start, 0);
  session.deactivate();
});

test("a failed narration component gets no checkmark and narration stays in the transcript", async () => {
  const { session } = setup({ output: new RecordingOutput("unavailable") });
  await session.activate();
  const narration = session.snapshot().readiness.find((check) => check.label === "Narration ready");
  assert.equal(narration?.ok, false);
  assert.deepEqual(said(session), ["Jarvis online."]);
  session.deactivate();
});

test("real control-plane events are narrated once, even if the log line repeats", async () => {
  const { session, plane, output } = setup();
  await session.activate();
  const id = plane.createMission(TODO).id;
  const file = plane.eventLogPath(id);
  session.readEvents(file);
  await session.flush();
  assert.ok(said(session).includes("Mission created."));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  fs.appendFileSync(file, `${lines[lines.findIndex((line) => line.includes("MissionCreated"))]}\n`);
  session.readEvents(file);
  await session.flush();
  assert.equal(said(session).filter((text) => text === "Mission created.").length, 1);
  assert.equal(output.spoken.filter((text) => text === "Mission created.").length, 1);
  assert.equal(said(session).some((text) => /WorkflowSelected/.test(text)), false);
  session.deactivate();
});

test("paused Jarvis neither narrates nor listens, and pausing Jarvis does not pause the mission", async () => {
  const { session, plane, calls } = setup({ running: true });
  await session.activate();
  const id = plane.createMission(TODO).id;
  session.pause();
  assert.equal(session.machine.state, "JARVIS_PAUSED");
  session.readEvents(plane.eventLogPath(id));
  session.startListening();
  assert.equal(session.machine.state, "JARVIS_PAUSED");
  assert.equal(said(session).includes("Mission created."), false);
  assert.equal(calls.stop, 0);
  assert.equal(plane.mission(id).loop, "draft");
  session.resume();
  assert.equal(session.machine.state, "JARVIS_ACTIVE");
  session.deactivate();
});

test("exiting Jarvis keeps the mission running and the transcript", async () => {
  const { session, plane, calls } = setup({ running: true });
  await session.activate();
  const id = plane.createMission(TODO).id;
  await session.submitText("What are you doing?");
  const before = plane.mission(id);
  session.deactivate();
  assert.equal(session.machine.state, "JARVIS_OFF");
  assert.equal(calls.stop, 0);
  assert.deepEqual(plane.mission(id), before);
  assert.ok(session.history.some((entry) => entry.who === "you" && entry.text === "What are you doing?"));
  await session.activate();
  assert.equal(session.snapshot().mission?.id, id);
  session.deactivate();
});

test("typed commands use the same validated pipeline; create_mission goes through the control plane", async () => {
  const { session, plane, calls } = setup();
  await session.activate();
  await session.submitText(TODO);
  const missions = plane.listMissions();
  assert.equal(missions.length, 1);
  assert.equal(plane.mission(missions[0]).input, TODO);
  assert.equal(calls.start, 1);
  await session.submitText("Build another todo web app with tags and due dates.");
  assert.equal(plane.listMissions().length, 1);
  assert.match(said(session).at(-1) ?? "", /autopilot is running another mission/);
  session.deactivate();
});

test("invalid interpretations and illegal mission transitions are refused with the real reason", async () => {
  const invalid = setup({ intent: new ScriptedIntent({ name: "drop_database" }) });
  await invalid.session.activate();
  await invalid.session.submitText("drop the database");
  assert.match(said(invalid.session).at(-1) ?? "", /"drop_database" is not a supported command/);
  invalid.session.deactivate();
  const illegal = setup();
  await illegal.session.activate();
  illegal.plane.createMission(TODO);
  await illegal.session.submitText("Pause.");
  assert.match(said(illegal.session).at(-1) ?? "", /^I can't do that: Pause applies to a running mission\./);
  illegal.session.deactivate();
});

test("speech can be interrupted, and a speech failure leaves the text visible", async () => {
  const holding = new RecordingOutput("hold");
  const { session } = setup({ output: holding });
  await session.activate();
  assert.equal(session.machine.state, "JARVIS_SPEAKING");
  session.stopSpeaking();
  assert.equal(holding.stopped > 0, true);
  assert.equal(session.machine.state, "JARVIS_ACTIVE");
  session.deactivate();
  const failing = setup({ output: new RecordingOutput("fail") });
  await failing.session.activate();
  await failing.session.flush();
  assert.equal(failing.session.machine.state, "JARVIS_ACTIVE");
  assert.ok(said(failing.session).some((text) => /^Speech output failed: speaker broke/.test(text)));
  assert.ok(said(failing.session).includes("Jarvis online."));
  failing.session.deactivate();
});

test("Gemini: unavailable without a key, times out, rejects malformed replies, and keeps the key out of URLs and errors", async () => {
  const none = new GeminiIntentProvider({});
  assert.equal(none.availability().ok, false);
  await assert.rejects(none.interpretText("status", {}), (error: VoiceError) => error.kind === "unavailable");
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const ok = new GeminiIntentProvider({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "gemini-3.8-flash" }, async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "what is blocked", intent: { name: "blocked" } }) }] } }] }) };
  });
  const reply = await ok.interpretText("what is blocked", { mission: { title: "t" } });
  assert.deepEqual(reply.intent, { name: "blocked" });
  assert.match(seen[0]?.url ?? "", /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal((seen[0]?.url ?? "").includes(KEY), false);
  assert.equal(seen[0]?.body.includes(KEY), false);
  assert.equal(seen[0]?.headers["x-goog-api-key"], KEY);
  const slow = new GeminiIntentProvider({ GEMINI_API_KEY: KEY, GEMINI_TIMEOUT: "30" }, (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  await assert.rejects(slow.interpretText("status", {}), (error: VoiceError) => error.kind === "timeout");
  const garbled = new GeminiIntentProvider({ GEMINI_API_KEY: KEY }, async () => ({ ok: true, status: 200, text: async () => "<html>oops</html>" }));
  await assert.rejects(garbled.interpretText("status", {}), (error: VoiceError) => error.kind === "malformed");
  const leaky = new GeminiIntentProvider({ GEMINI_API_KEY: KEY }, async () => {
    throw new Error(`connect failed for key=${KEY}`);
  });
  await assert.rejects(leaky.interpretText("status", {}), (error: VoiceError) => !error.message.includes(KEY));
  const denied = new GeminiIntentProvider({ GEMINI_API_KEY: KEY }, async () => ({ ok: false, status: 403, text: async () => "forbidden" }));
  await assert.rejects(denied.interpretText("status", {}), (error: VoiceError) => error.kind === "unavailable" && /HTTP 403/.test(error.message));
});

test("when the voice service fails, typed commands still work and nothing exposes the key", async () => {
  const failing = new GeminiIntentProvider({ GEMINI_API_KEY: KEY, GEMINI_TIMEOUT: "30" }, (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const { session, snapshots } = setup({ intent: failing });
  await session.activate();
  await session.submitText("What are you doing?");
  assert.ok(said(session).some((text) => /Voice service timed out after 30 ms\. Using the local command parser\./.test(text)));
  assert.match(said(session).at(-1) ?? "", /^There is no active mission\./);
  assert.equal(JSON.stringify(snapshots).includes(KEY), false);
  assert.equal(JSON.stringify(session.history).includes(KEY), false);
  session.deactivate();
});

test("a denied microphone is reported with a recovery step, and no audio is sent anywhere", async () => {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; stdin: { write(): void; end(): void }; stderr: EventEmitter; kill(): void };
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  child.stdin = {
    write: () => undefined,
    end: () => {
      child.stderr.emit("data", Buffer.from("[avfoundation] not authorized to capture audio"));
      child.exitCode = 1;
      setImmediate(() => child.emit("exit", 1));
    },
  };
  const microphone = new FfmpegMicrophoneInput(":0", () => child as never, () => true, "darwin");
  assert.equal(microphone.availability().ok, true);
  microphone.start();
  await assert.rejects(microphone.stop(), (error: VoiceError) => error.kind === "permission" && /System Settings > Privacy & Security > Microphone/.test(error.message));
  assert.equal(new FfmpegMicrophoneInput(":0", () => child as never, () => false, "darwin").availability().ok, false);
});
