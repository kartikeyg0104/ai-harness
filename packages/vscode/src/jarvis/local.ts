import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JARVIS_INTENTS, redactSecrets } from "@bmad-next/control-plane";
import { VoiceError, type AudioClip, type Availability, type InterpretedCommand, type VoiceIntentProvider } from "./providers";

/**
 * Jarvis without a cloud service: whisper.cpp hears (and detects the language) on this machine, and the same Ollama
 * model that builds the mission understands the request and answers in the language it was asked in.
 */
export interface LocalVoiceConfig {
  url: string;
  model: string;
  /** Sent as a bearer token when the endpoint needs one (a hosted provider); local Ollama needs none. */
  apiKey: string;
  whisperServer: string;
  whisperModel: string;
  timeoutMs: number;
}

export function localVoiceConfig(env: NodeJS.ProcessEnv = process.env): LocalVoiceConfig {
  const cache = path.join(os.homedir(), ".cache", "bmad-next", "whisper");
  return {
    url: (env.BMAD_JARVIS_URL ?? "").trim() || (env.AI_BASE_URL ?? "").trim() || "http://127.0.0.1:11434/v1",
    model: (env.BMAD_JARVIS_MODEL ?? "").trim() || (env.BMAD_MODEL ?? "").replace(/^ollama\//, "").trim() || "qwen3-coder:30b",
    apiKey: (env.BMAD_JARVIS_API_KEY ?? "").trim() || (env.AI_API_KEY ?? "").trim(),
    whisperServer: (env.BMAD_WHISPER_SERVER ?? "").trim() || "whisper-server",
    whisperModel: (env.BMAD_WHISPER_MODEL ?? "").trim() || path.join(cache, "ggml-large-v3-turbo-q5_0.bin"),
    timeoutMs: Number(env.BMAD_JARVIS_TIMEOUT) > 0 ? Number(env.BMAD_JARVIS_TIMEOUT) : 90000,
  };
}

const LANGUAGE_CODES: Record<string, string> = {
  english: "en", hindi: "hi", marathi: "mr", bengali: "bn", tamil: "ta", telugu: "te", gujarati: "gu", punjabi: "pa", urdu: "ur",
  kannada: "kn", malayalam: "ml", nepali: "ne", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
  russian: "ru", japanese: "ja", korean: "ko", chinese: "zh", arabic: "ar", dutch: "nl", turkish: "tr",
};

/** Whisper names languages ("hindi"); speech and prompts use ISO 639-1 codes ("hi"). */
export function languageCode(name: string): string {
  const clean = name.trim().toLowerCase();
  return LANGUAGE_CODES[clean] ?? (clean.length === 2 ? clean : "en");
}

// ---------------------------------------------------------------------------------------------------------------
// Hearing: a whisper.cpp server that keeps the model loaded, so each utterance takes about a second.

export class WhisperService {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly config: LocalVoiceConfig,
    private readonly which: (bin: string) => boolean = (bin) => spawnSync("which", [bin]).status === 0,
  ) {}

  availability(): Availability {
    if (!this.which(this.config.whisperServer)) return { ok: false, reason: "whisper.cpp is not installed (brew install whisper-cpp)." };
    if (!fs.existsSync(this.config.whisperModel)) return { ok: false, reason: `Whisper model missing at ${this.config.whisperModel}.` };
    return { ok: true, reason: `whisper.cpp ${path.basename(this.config.whisperModel)}` };
  }

  private start(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    this.port = 18700 + Math.floor(Math.random() * 200);
    const child = spawn(this.config.whisperServer, ["-m", this.config.whisperModel, "-l", "auto", "--host", "127.0.0.1", "--port", String(this.port)], { stdio: "ignore" });
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.starting = (async () => {
      for (let i = 0; i < 120; i += 1) {
        if (child.exitCode !== null) throw new VoiceError("unavailable", "The speech recogniser stopped while loading.");
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/`);
          if (response.ok || response.status === 404) return;
        } catch {
          // Still loading.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new VoiceError("timeout", "The speech recogniser did not start within a minute.");
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** The words in a WAV clip and the language they were spoken in. */
  async transcribe(wav: Buffer): Promise<{ text: string; language: string }> {
    const ready = this.availability();
    if (!ready.ok) throw new VoiceError("unavailable", ready.reason);
    await this.start();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "verbose_json");
    form.append("language", "auto");
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new VoiceError("failed", `The speech recogniser returned HTTP ${response.status}.`);
    const body = (await response.json()) as { text?: string; language?: string };
    const text = String(body.text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    return { text, language: languageCode(String(body.language ?? "english")) };
  }

  dispose(): void {
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    this.child = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Understanding: the Ollama model, grounded in the mission's real state, answering in the speaker's language.

const INTENT_HELP = [
  "create_mission: start building something new. intent.idea is a clear English description of what to build, one or two sentences, even when the person spoke another language: translate it, and correct obvious speech-recognition slips (\"tudu\" or \"तुदू\" means todo).",
  "status, agents, phase, blocked, review, evidence, summarize: questions about the mission.",
  "continue, pause, resume, stop: control the autopilot.",
  "accept_tickets: the person accepts the proposed ticket tree.",
  "approve_release: the person approves the release; put their reason, in English, in intent.reason.",
  "exit_jarvis: turn Jarvis off.",
  "unknown: anything else, including small talk; answer it briefly from the facts.",
].join("\n");

const SYSTEM = [
  "You are Jarvis, the voice of BMAD Next, a software delivery autopilot inside VS Code. You speak like a calm, capable assistant.",
  "Reply in the language the person used: Hindi in Devanagari, Hinglish in Hinglish, English in English, and so on.",
  "Keep every reply to one to three short sentences meant to be spoken aloud. No markdown, lists, or code.",
  "Use only the facts you are given. Never invent progress, results, or agents.",
  "For an action, say what you are doing, not that it is done.",
  `Choose exactly one intent:\n${INTENT_HELP}`,
  `Allowed intent names: ${JARVIS_INTENTS.join(", ")}.`,
  'Reply with JSON only: {"language":"<ISO 639-1 code>","reply":"<what you will say>","intent":{"name":"<intent>","idea":"<only for create_mission>","reason":"<only for approve_release>"}}',
].join("\n");

type Fetch = typeof fetch;

export class LocalIntentProvider implements VoiceIntentProvider {
  readonly id = "local";

  constructor(
    private readonly config: LocalVoiceConfig,
    readonly whisper: WhisperService,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Speech needs whisper.cpp; typed requests only need the model. */
  availability(): Availability {
    const hearing = this.whisper.availability();
    return hearing.ok ? { ok: true, reason: `${hearing.reason} and ${this.config.model}` } : hearing;
  }

  textReady(): boolean {
    return Boolean(this.config.url && this.config.model);
  }

  async interpretText(text: string, context: Record<string, unknown>, language?: string): Promise<InterpretedCommand> {
    const clean = redactSecrets(text).slice(0, 2000);
    const hint = language ? `\nThe speech recogniser heard ${language}.` : "";
    const raw = await this.chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: `Facts about the mission right now:\n${JSON.stringify(context, null, 1)}${hint}\n\nThe person said: ${clean}` },
    ], true);
    let reply: { language?: unknown; reply?: unknown; intent?: unknown };
    try {
      reply = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as typeof reply;
    } catch {
      throw new VoiceError("malformed", "Jarvis could not read the model's answer.");
    }
    const intent = (reply.intent ?? { name: "unknown" }) as Record<string, unknown>;
    // The builder works from English; an idea in another script is translated before the mission is created.
    if (intent.name === "create_mission" && typeof intent.idea === "string" && /[^\x00-\x7F]/.test(intent.idea)) {
      intent.idea = await this.translate(intent.idea, "en");
    }
    return {
      transcript: clean,
      intent,
      provider: this.id,
      reply: typeof reply.reply === "string" ? reply.reply.trim().slice(0, 600) : undefined,
      language: typeof reply.language === "string" && /^[a-z]{2}$/.test(reply.language) ? reply.language : language ?? "en",
    };
  }

  async interpretAudio(clip: AudioClip, context: Record<string, unknown>): Promise<InterpretedCommand> {
    const heard = await this.whisper.transcribe(clip.data);
    if (!heard.text) throw new VoiceError("silent", "I did not catch any words.");
    const result = await this.interpretText(heard.text, context, heard.language);
    return { ...result, transcript: heard.text };
  }

  /** Puts an English sentence into the person's language, for results the control plane reports in English. */
  async translate(text: string, language: string): Promise<string> {
    if (!language || (language === "en" && !/[^\x00-\x7F]/.test(text))) return text;
    const out = await this.chat([
      { role: "system", content: `Translate the user's text into the language with ISO 639-1 code "${language}". Keep names, ids, and numbers as they are. Output only the translation, one or two spoken sentences.` },
      { role: "user", content: text },
    ], false);
    return out.trim() || text;
  }

  private async chat(messages: Array<{ role: string; content: string }>, json: boolean): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.model, messages, temperature: 0.2, stream: false, ...(json ? { response_format: { type: "json_object" } } : {}) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new VoiceError(timedOut ? "timeout" : "unavailable", timedOut ? `The model did not answer within ${Math.round(this.config.timeoutMs / 1000)} s.` : `The model is unreachable at ${this.config.url}.`);
    }
    if (!response.ok) throw new VoiceError("unavailable", `The model returned HTTP ${response.status}.`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return String(body.choices?.[0]?.message?.content ?? "");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hands-free listening: an open microphone that cuts speech into utterances by loudness.

const RATE = 16000;
const FRAME = 480; // 30 ms

export interface UtteranceEvents {
  onUtterance(clip: AudioClip): void;
  onHearing?(hearing: boolean): void;
  onError?(message: string): void;
}

/**
 * Keeps the microphone open while hands-free or wake-word listening is on. A short burst of loud frames starts an
 * utterance; three quarters of a second of quiet ends it. While muted (Jarvis is speaking or thinking) audio is
 * dropped, so Jarvis never hears itself.
 */
export class ContinuousMicrophone {
  private child: ChildProcess | null = null;
  private pending = Buffer.alloc(0);
  private frames: Buffer[] = [];
  private preroll: Buffer[] = [];
  private loud = 0;
  private quiet = 0;
  private speaking = false;
  private floor = 300;
  private muted = false;
  private stderr = "";

  constructor(private readonly device = ":0") {}

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  start(events: UtteranceEvents): void {
    if (this.running) return;
    this.stderr = "";
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", this.device, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => this.feed(chunk, events));
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      if (code && code !== 255 && events.onError) {
        events.onError(/not authorized|permission|denied|Input\/output error/i.test(this.stderr)
          ? "Microphone unavailable. Allow Visual Studio Code under System Settings > Privacy & Security > Microphone."
          : `The microphone stopped (${this.stderr.trim().split("\n").at(-1) ?? `exit ${String(code)}`}).`);
      }
    });
  }

  mute(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.reset();
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    this.reset();
  }

  private reset(): void {
    this.frames = [];
    this.preroll = [];
    this.loud = 0;
    this.quiet = 0;
    this.speaking = false;
    this.pending = Buffer.alloc(0);
  }

  private feed(chunk: Buffer, events: UtteranceEvents): void {
    if (this.muted) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME * 2) {
      const frame = this.pending.subarray(0, FRAME * 2);
      this.pending = this.pending.subarray(FRAME * 2);
      this.frame(Buffer.from(frame), events);
    }
  }

  private frame(frame: Buffer, events: UtteranceEvents): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) {
      const v = frame.readInt16LE(i);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (frame.length / 2));
    const loud = rms > Math.max(this.floor * 3, 450);
    if (!this.speaking) {
      // The noise floor follows the room while nobody is talking.
      this.floor = this.floor * 0.97 + Math.min(rms, 4000) * 0.03;
      this.preroll.push(frame);
      if (this.preroll.length > 10) this.preroll.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (this.loud >= 5) {
        this.speaking = true;
        this.frames = [...this.preroll];
        this.quiet = 0;
        events.onHearing?.(true);
      }
      return;
    }
    this.frames.push(frame);
    this.quiet = loud ? 0 : this.quiet + 1;
    const long = this.frames.length * 30 >= 15000;
    if (this.quiet >= 25 || long) {
      const pcm = Buffer.concat(this.frames);
      this.reset();
      events.onHearing?.(false);
      if (pcm.length / 2 / RATE >= 0.45) events.onUtterance({ mimeType: "audio/wav", data: wav(pcm), durationMs: Math.round((pcm.length / 2 / RATE) * 1000) });
    }
  }
}

/** A 16 kHz mono 16-bit WAV file around raw PCM. */
export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------------------------------------------
// The wake phrase, in the spellings a recogniser produces for "Hey Jarvis" in English and Hindi. JavaScript's \b only
// knows ASCII letters, so the end of the name is an explicit separator or the end of the text.

const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|हे|हेय|हाय|ओके)[\s,!.]+)?(?:jarvis|jarvi?s|jervis|jarves|travis|जार्विस|जारविस|जार्वेस|जारवीस)(?=[\s,!.:।?-]|$)[\s,!.:।-]*/iu;

/** The request after a wake phrase ("" when the person only said the phrase), or null when there was no wake phrase. */
export function afterWakePhrase(text: string): string | null {
  const match = WAKE.exec(text);
  if (!match) return null;
  return text.slice(match[0].length).replace(/^[\s,!.:।-]+/u, "").trim();
}
