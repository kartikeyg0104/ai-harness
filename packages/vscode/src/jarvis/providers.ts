import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JARVIS_INTENTS, parseCommand, redactSecrets } from "@bmad-next/control-plane";

/**
 * Voice providers for Jarvis. They run in the extension host only. Nothing here touches mission state: an intent
 * provider interprets, and the session validates the result before any control-plane call.
 */

export interface Availability {
  ok: boolean;
  reason: string;
}

export interface AudioClip {
  mimeType: string;
  data: Buffer;
  durationMs: number;
}

export interface InterpretedCommand {
  transcript: string;
  intent: unknown;
  provider: string;
}

export interface VoiceInputProvider {
  readonly id: string;
  availability(): Availability;
  start(): void;
  stop(): Promise<AudioClip>;
  cancel(): void;
}

export interface VoiceIntentProvider {
  readonly id: string;
  availability(): Availability;
  interpretText(text: string, context: Record<string, unknown>): Promise<InterpretedCommand>;
  interpretAudio(clip: AudioClip, context: Record<string, unknown>): Promise<InterpretedCommand>;
}

export interface VoiceOutputProvider {
  readonly id: string;
  availability(): Availability;
  speak(text: string): Promise<void>;
  stop(): void;
}

export class VoiceError extends Error {
  constructor(
    readonly kind: "unavailable" | "timeout" | "malformed" | "permission" | "silent" | "failed",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Intent: Gemini

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const SYSTEM = [
  "You turn one spoken or typed request into a command for BMAD Next, a software delivery control plane.",
  `Allowed intent names: ${JARVIS_INTENTS.join(", ")}.`,
  "create_mission needs idea: the full description of what to build, in the user's words.",
  "status covers what is happening now; agents covers which agents run; blocked covers blockers; review covers reviewer results.",
  "continue, pause, resume, and stop act on the mission; exit_jarvis leaves voice mode. Anything else is unknown.",
  "You do not answer the question and you do not change anything. Reply with JSON only:",
  '{"transcript":"<what the user said>","intent":{"name":"<intent>","idea":"<only for create_mission>"}}',
].join("\n");

/** Gemini behind the provider interface. The key is read here, in the extension host, and never leaves it. */
export class GeminiIntentProvider implements VoiceIntentProvider {
  readonly id = "gemini";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private get key(): string {
    return (this.env.GEMINI_API_KEY ?? "").trim();
  }

  get model(): string {
    return (this.env.GEMINI_MODEL ?? "").trim() || "gemini-3.8-flash";
  }

  availability(): Availability {
    return this.key ? { ok: true, reason: `Gemini model ${this.model}` } : { ok: false, reason: "GEMINI_API_KEY is not set in the extension host environment." };
  }

  interpretText(text: string, context: Record<string, unknown>): Promise<InterpretedCommand> {
    return this.request([{ text: `Mission context: ${JSON.stringify(context)}\nRequest: ${redactSecrets(text).slice(0, 2000)}` }]);
  }

  interpretAudio(clip: AudioClip, context: Record<string, unknown>): Promise<InterpretedCommand> {
    return this.request([
      { inline_data: { mime_type: clip.mimeType, data: clip.data.toString("base64") } },
      { text: `Mission context: ${JSON.stringify(context)}\nTranscribe the audio, then classify it.` },
    ]);
  }

  private async request(parts: unknown[]): Promise<InterpretedCommand> {
    if (!this.key) throw new VoiceError("unavailable", "Voice service unavailable: GEMINI_API_KEY is not set.");
    const timeout = Number(this.env.GEMINI_TIMEOUT) > 0 ? Number(this.env.GEMINI_TIMEOUT) : 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let status = 0;
    let body = "";
    try {
      const response = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        signal: controller.signal,
      });
      status = response.status;
      body = await response.text();
      if (!response.ok) throw new VoiceError("unavailable", `Voice service unavailable: Gemini returned HTTP ${status}.`);
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (controller.signal.aborted) throw new VoiceError("timeout", `Voice service timed out after ${timeout} ms.`);
      throw new VoiceError("unavailable", `Voice service unavailable: ${this.scrub(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearTimeout(timer);
    }
    let text = "";
    try {
      const parsed = JSON.parse(body) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      text = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      const reply = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { transcript?: unknown; intent?: unknown };
      if (!reply || typeof reply !== "object" || !reply.intent) throw new Error("no intent");
      return { transcript: typeof reply.transcript === "string" ? redactSecrets(reply.transcript).slice(0, 2000) : "", intent: reply.intent, provider: this.id };
    } catch {
      throw new VoiceError("malformed", "Voice service returned a response Jarvis could not read.");
    }
  }

  /** Error text from a network stack could echo the request; never let the key through. */
  private scrub(message: string): string {
    return redactSecrets(this.key ? message.split(this.key).join("[redacted]") : message);
  }
}

/** Typed commands without a model: the same intents, parsed deterministically. It cannot hear audio. */
export class TextCommandIntentProvider implements VoiceIntentProvider {
  readonly id = "text-parser";

  availability(): Availability {
    return { ok: true, reason: "Typed commands are parsed locally." };
  }

  interpretText(text: string): Promise<InterpretedCommand> {
    return Promise.resolve({ transcript: text, intent: parseCommand(text), provider: this.id });
  }

  interpretAudio(): Promise<InterpretedCommand> {
    return Promise.reject(new VoiceError("unavailable", "Voice service unavailable: spoken commands need a voice intent provider."));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output: system speech

type Spawner = (command: string, args: string[]) => ChildProcess;

/** macOS `say`. Speech can be interrupted; a failed voice leaves the text in the transcript. */
export class SystemSpeechOutput implements VoiceOutputProvider {
  readonly id = "system-tts";
  private current: ChildProcess | null = null;

  constructor(
    private readonly spawner: Spawner = (command, args) => spawn(command, args, { stdio: "ignore" }),
    private readonly which: (bin: string) => boolean = (bin) => spawnSync("which", [bin]).status === 0,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  availability(): Availability {
    if (this.platform !== "darwin") return { ok: false, reason: "System speech is implemented with macOS say." };
    return this.which("say") ? { ok: true, reason: "macOS say" } : { ok: false, reason: "say is not on PATH." };
  }

  speak(text: string): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawner("say", ["-r", "190", text]);
      } catch (error) {
        reject(new VoiceError("failed", `Speech failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.current = child;
      child.once("error", (error) => {
        if (this.current === child) this.current = null;
        reject(new VoiceError("failed", `Speech failed: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (this.current === child) this.current = null;
        if (code === 0 || signal) resolve();
        else reject(new VoiceError("failed", `Speech exited with code ${String(code)}.`));
      });
    });
  }

  stop(): void {
    const child = this.current;
    this.current = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Input: push-to-talk microphone

/**
 * Push-to-talk capture with ffmpeg (AVFoundation). Recording runs only between start() and stop(), which the UI
 * ties to the user holding the talk button. macOS asks the user for microphone access the first time.
 */
export class FfmpegMicrophoneInput implements VoiceInputProvider {
  readonly id = "ffmpeg-avfoundation";
  private child: ChildProcess | null = null;
  private file = "";
  private started = 0;
  private stderr = "";

  constructor(
    private readonly device = ":0",
    private readonly spawner: Spawner = (command, args) => spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] }),
    private readonly which: (bin: string) => boolean = (bin) => spawnSync("which", [bin]).status === 0,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  availability(): Availability {
    if (this.platform !== "darwin") return { ok: false, reason: "Microphone capture is implemented with macOS AVFoundation." };
    return this.which("ffmpeg") ? { ok: true, reason: "ffmpeg AVFoundation" } : { ok: false, reason: "ffmpeg is not on PATH." };
  }

  start(): void {
    if (this.child) return;
    this.file = path.join(os.tmpdir(), `bmad-jarvis-${process.pid}-${Date.now()}.wav`);
    this.stderr = "";
    this.started = Date.now();
    const child = this.spawner("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", this.device, "-t", "30", "-ac", "1", "-ar", "16000", "-y", this.file]);
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.once("error", (error) => {
      this.stderr += error.message;
    });
    this.child = child;
  }

  stop(): Promise<AudioClip> {
    const child = this.child;
    this.child = null;
    if (!child) return Promise.reject(new VoiceError("failed", "The microphone was not recording."));
    return new Promise((resolve, reject) => {
      const finish = () => {
        const durationMs = Date.now() - this.started;
        const exists = fs.existsSync(this.file);
        const data = exists ? fs.readFileSync(this.file) : Buffer.alloc(0);
        if (exists) fs.rmSync(this.file, { force: true });
        if (/not authorized|permission|denied|Input\/output error|Could not|Failed to/i.test(this.stderr) || data.length <= 44) {
          reject(new VoiceError("permission", "Microphone unavailable. Allow Visual Studio Code under System Settings > Privacy & Security > Microphone, then try again."));
          return;
        }
        if (peak(data) === 0) {
          reject(new VoiceError("silent", "The microphone recorded silence. Check the input device or microphone permission."));
          return;
        }
        resolve({ mimeType: "audio/wav", data, durationMs });
      };
      if (child.exitCode !== null) {
        finish();
        return;
      }
      child.once("exit", finish);
      child.stdin?.write("q");
      child.stdin?.end();
      setTimeout(() => child.exitCode === null && child.kill("SIGINT"), 1500);
    });
  }

  cancel(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (this.file) fs.rmSync(this.file, { force: true });
  }
}

/** Largest absolute 16-bit sample after the 44-byte WAV header. */
export function peak(wav: Buffer): number {
  let max = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) max = Math.max(max, Math.abs(wav.readInt16LE(offset)));
  return max;
}
