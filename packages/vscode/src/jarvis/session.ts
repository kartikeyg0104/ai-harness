import fs from "node:fs";
import path from "node:path";
import {
  JarvisMachine,
  NarrationLog,
  answerQuestion,
  deriveAgents,
  deriveTimeline,
  evaluateRelease,
  narrateEvent,
  sanitizedContext,
  shouldSpeak,
  validateIntent,
  type AgentActivity,
  type BmadControlPlane,
  type DomainEvent,
  type JarvisIntent,
  type JarvisState,
  type Mission,
  type NarrationCategory,
  type NarrationLevel,
  type TimelineItem,
} from "@bmad-next/control-plane";
import { VoiceError, type AudioClip, type Availability, type InterpretedCommand, type VoiceInputProvider, type VoiceIntentProvider, type VoiceOutputProvider } from "./providers";
import { afterWakePhrase, type ContinuousMicrophone } from "./local";

/**
 * A Jarvis session is a view and command channel over the control plane. Its own state (on, listening, speaking,
 * paused) is separate from the mission's: exiting or pausing Jarvis never pauses, stops, or starts a mission.
 */

export interface JarvisHost {
  root: string;
  plane(): BmadControlPlane;
  autopilotRunning(): boolean;
  startAutopilot(): void;
  stopAutopilot(missionId: string): void;
  showEvidence(): void;
  /** Records the person's spoken acceptance of the ticket tree; returns what happened, in English. */
  acceptTickets(): string;
  /** Records the person's spoken release approval with their reason; returns what happened, in English. */
  approveRelease(reason: string): string;
}

export interface JarvisSettings {
  narration: NarrationLevel;
  voiceOutput: "system" | "off";
  autoListen: "off" | "pushToTalk";
}

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface TranscriptEntry {
  who: "you" | "jarvis";
  text: string;
  at: string;
  kind: "command" | "answer" | "narration" | "error";
  category?: NarrationCategory;
}

export interface JarvisSnapshot {
  state: JarvisState;
  paused: boolean;
  readiness: ReadinessCheck[];
  voice: Availability;
  microphone: Availability;
  narration: Availability & { level: NarrationLevel };
  autoListen: JarvisSettings["autoListen"];
  mission: { id: string; title: string; phase: string; loop: string; release: string } | null;
  agents: AgentActivity[];
  recent: AgentActivity[];
  timeline: TimelineItem[];
  transcript: TranscriptEntry[];
  completion: { gates: Array<{ label: string; state: string }>; release: string } | null;
  error: string | null;
  /** Hands-free and wake-word listening, and whether speech is being heard right now. */
  listen: { handsFree: boolean; wakeWord: boolean; hearing: boolean; available: boolean };
  /** The language the person last spoke in; replies and narration follow it. */
  language: string;
}

export interface JarvisProviders {
  input: VoiceInputProvider | null;
  intent: VoiceIntentProvider;
  fallback: VoiceIntentProvider;
  output: VoiceOutputProvider | null;
  /** An open microphone for hands-free and wake-word listening. */
  continuous?: ContinuousMicrophone | null;
  /** Speech to text with the detected language, for hands-free utterances. */
  transcriber?: { transcribe(wav: Buffer): Promise<{ text: string; language: string }>; availability(): Availability } | null;
}

/** Commands that change something; their results come from the control plane, not from the model. */
const ACTIONS = new Set(["create_mission", "continue", "pause", "resume", "stop", "accept_tickets", "approve_release", "exit_jarvis"]);

export class JarvisSession {
  readonly machine = new JarvisMachine();
  private readonly narrated = new NarrationLog();
  private readonly offsets = new Map<string, number>();
  private readonly queue: Array<{ text: string; language: string }> = [];
  private language = "en";
  private readonly listen = { handsFree: false, wakeWord: false, hearing: false };
  private narrationChain: Promise<void> = Promise.resolve();
  private transcript: TranscriptEntry[] = [];
  private readiness: ReadinessCheck[] = [];
  private watcher: fs.FSWatcher | null = null;
  private speaking = false;
  private error: string | null = null;

  constructor(
    private readonly host: JarvisHost,
    private readonly providers: JarvisProviders,
    private settings: JarvisSettings,
    private readonly onUpdate: (snapshot: JarvisSnapshot) => void,
    history: TranscriptEntry[] = [],
  ) {
    this.transcript = history.slice(-200);
    this.machine.onChange(() => {
      this.syncMicrophone();
      this.publish();
    });
  }

  get history(): TranscriptEntry[] {
    return this.transcript;
  }

  configure(settings: JarvisSettings): void {
    this.settings = settings;
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  /** Explicit activation only. Checks are real: a failed component gets no checkmark. */
  async activate(): Promise<void> {
    if (this.machine.state !== "JARVIS_OFF" && this.machine.state !== "JARVIS_ERROR") return;
    this.error = null;
    this.machine.to("JARVIS_STARTING");
    const voice = this.voiceAvailability();
    const microphone = this.providers.input?.availability() ?? { ok: false, reason: "No microphone provider." };
    this.readiness = [
      { label: "Voice input ready", ok: voice.ok && microphone.ok && this.settings.autoListen !== "off", detail: !microphone.ok ? microphone.reason : !voice.ok ? voice.reason : this.settings.autoListen === "off" ? "Listening is turned off in settings." : `Push-to-talk · ${voice.reason}` },
    ];
    this.publish();
    let mission: Mission | null = null;
    try {
      mission = this.activeMission();
      this.readiness.push({ label: "Mission context ready", ok: true, detail: mission ? `${mission.id} · ${mission.phase}` : "No active mission yet." });
    } catch (error) {
      this.readiness.push({ label: "Mission context ready", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    this.publish();
    const connected = this.connect();
    this.readiness.push({ label: "Event stream connected", ok: connected.ok, detail: connected.reason });
    const narration = this.narrationAvailability();
    this.readiness.push({ label: "Narration ready", ok: narration.ok, detail: narration.reason });
    if (!connected.ok) {
      this.error = connected.reason;
      this.machine.to("JARVIS_ERROR");
      return;
    }
    this.machine.to("JARVIS_ACTIVE");
    this.say("Jarvis online.", "answer", "IMPORTANT");
  }

  /** Stops listening, speech, and the event subscription. The mission and the transcript are untouched. */
  deactivate(): void {
    this.providers.input?.cancel();
    this.stopSpeaking();
    this.disconnect();
    if (this.machine.state !== "JARVIS_OFF") this.machine.to("JARVIS_OFF");
    this.syncMicrophone();
    this.publish();
  }

  /** Ends every listening mode and releases the microphone, for example when the editor closes. */
  dispose(): void {
    this.listen.handsFree = false;
    this.listen.wakeWord = false;
    this.providers.continuous?.stop();
    this.deactivate();
  }

  // ------------------------------------------------------------------------------------------------ hands-free

  /** Turns hands-free conversation or wake-word listening on or off. Both are explicit choices a person makes. */
  setListening(mode: { handsFree?: boolean; wakeWord?: boolean }): void {
    if (mode.handsFree !== undefined) this.listen.handsFree = mode.handsFree;
    if (mode.wakeWord !== undefined) this.listen.wakeWord = mode.wakeWord;
    if ((this.listen.handsFree || this.listen.wakeWord) && !this.providers.transcriber?.availability().ok) {
      const reason = this.providers.transcriber?.availability().reason ?? "No speech recogniser is configured.";
      this.listen.handsFree = false;
      this.listen.wakeWord = false;
      this.fail(`Hands-free listening needs speech recognition: ${reason}`);
    }
    this.syncMicrophone();
    this.publish();
  }

  /** The open microphone runs only while a listening mode needs it, and is muted while Jarvis thinks or speaks. */
  private syncMicrophone(): void {
    const mic = this.providers.continuous;
    if (!mic) return;
    const state = this.machine.state;
    const want = this.listen.wakeWord || (this.listen.handsFree && this.machine.on && state !== "JARVIS_PAUSED");
    if (want && !mic.running) {
      mic.start({
        onUtterance: (clip) => void this.onUtterance(clip),
        onHearing: (hearing) => {
          this.listen.hearing = hearing;
          this.publish();
        },
        onError: (message) => {
          this.listen.handsFree = false;
          this.listen.wakeWord = false;
          this.listen.hearing = false;
          this.fail(message);
          this.publish();
        },
      });
    } else if (!want && mic.running) {
      mic.stop();
      this.listen.hearing = false;
    }
    mic.mute(["JARVIS_SPEAKING", "JARVIS_PROCESSING", "JARVIS_LISTENING", "JARVIS_STARTING"].includes(state));
  }

  /**
   * One spoken utterance. While Jarvis is off, or when only the wake word is on, it must start with "Hey Jarvis";
   * in hands-free conversation every utterance is a request.
   */
  private async onUtterance(clip: AudioClip): Promise<void> {
    const transcriber = this.providers.transcriber;
    if (!transcriber) return;
    let heard: { text: string; language: string };
    try {
      heard = await transcriber.transcribe(clip.data);
    } catch (error) {
      if (this.machine.on) this.fail(error instanceof VoiceError ? error.message : `Speech recognition failed: ${String(error)}`);
      return;
    }
    if (!heard.text) return;
    const wake = afterWakePhrase(heard.text);
    const needsWake = !this.machine.on || !this.listen.handsFree;
    if (needsWake && wake === null) return;
    const request = wake ?? heard.text;
    if (heard.language) this.language = heard.language;
    if (!this.machine.on) {
      await this.activate();
      if (!this.machine.on) return;
    }
    if (!request) {
      this.say(await this.localize("Yes? I'm listening."), "answer", "IMPORTANT");
      return;
    }
    await this.request(request, heard.language);
  }

  /** Jarvis stops listening and narrating. Events that arrive meanwhile are consumed silently. */
  pause(): void {
    if (!this.machine.on || this.machine.state === "JARVIS_PAUSED") return;
    this.providers.input?.cancel();
    this.stopSpeaking();
    this.machine.to("JARVIS_PAUSED");
  }

  resume(): void {
    if (this.machine.state !== "JARVIS_PAUSED") return;
    this.machine.to("JARVIS_ACTIVE");
  }

  stopSpeaking(): void {
    this.queue.length = 0;
    this.providers.output?.stop();
    this.speaking = false;
    if (this.machine.state === "JARVIS_SPEAKING") this.machine.to("JARVIS_ACTIVE");
  }

  // ------------------------------------------------------------------------------------------------ input

  startListening(): void {
    if (this.machine.state === "JARVIS_PAUSED" || !this.machine.on) return;
    if (this.settings.autoListen === "off") return this.fail("Listening is turned off in settings. Type a command instead.");
    const input = this.providers.input;
    const microphone = input?.availability() ?? { ok: false, reason: "No microphone provider." };
    if (!input || !microphone.ok) return this.fail(`Microphone unavailable: ${microphone.reason}`);
    const voice = this.voiceAvailability();
    if (!voice.ok) return this.fail(`Voice service unavailable: ${voice.reason} Type a command instead.`);
    this.stopSpeaking();
    input.start();
    this.machine.to("JARVIS_LISTENING");
  }

  async stopListening(): Promise<void> {
    if (this.machine.state !== "JARVIS_LISTENING" || !this.providers.input) return;
    this.machine.to("JARVIS_PROCESSING");
    try {
      const clip = await this.providers.input.stop();
      const interpreted = await this.providers.intent.interpretAudio(clip, this.context());
      this.record("you", interpreted.transcript || "(no speech recognised)", "command");
      await this.respond(interpreted);
    } catch (error) {
      this.fail(error instanceof VoiceError ? error.message : `Voice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((this.machine.state as JarvisState) === "JARVIS_PROCESSING") this.machine.to("JARVIS_ACTIVE");
    this.drain();
  }

  /** Typed commands take the same path as speech: interpret, validate, then act through the control plane. */
  async submitText(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || !this.machine.on) return;
    await this.request(clean);
  }

  /** A typed or spoken request: understand it, act through the control plane, and answer in the person's language. */
  private async request(text: string, heardLanguage?: string): Promise<void> {
    this.record("you", text, "command");
    const resumeTo = this.machine.state === "JARVIS_PAUSED" ? null : this.machine.state;
    if (resumeTo && this.machine.can("JARVIS_PROCESSING")) this.machine.to("JARVIS_PROCESSING");
    let interpreted: InterpretedCommand;
    const intent = this.providers.intent;
    const ready = intent.textReady ? intent.textReady() : this.voiceAvailability().ok;
    try {
      interpreted = ready ? await intent.interpretText(text, this.context(), heardLanguage) : await this.providers.fallback.interpretText(text, {});
    } catch (error) {
      const reason = error instanceof VoiceError ? error.message : String(error);
      this.record("jarvis", `${reason} Using the local command parser.`, "error");
      interpreted = await this.providers.fallback.interpretText(text, {});
    }
    await this.respond(interpreted);
    if (this.machine.state === "JARVIS_PROCESSING") this.machine.to("JARVIS_ACTIVE");
    this.drain();
  }

  /** What the model may know: the mission's real state, as the control plane reports it. */
  private context(): Record<string, unknown> {
    const mission = safe(() => this.activeMission());
    if (this.providers.intent.id !== "local") return sanitizedContext(mission);
    if (!mission) return { mission: null, note: "There is no active mission. The person can ask Jarvis to build something." };
    const plane = this.host.plane();
    const events = safe(() => plane.events(mission.id)) ?? [];
    const next = safe(() => plane.recommend(mission.id));
    const answer = (name: Parameters<typeof answerQuestion>[0]) => safe(() => answerQuestion(name, mission, events, next));
    return {
      mission: { title: mission.title, loop: mission.loop, phase: mission.phase },
      autopilotRunning: this.host.autopilotRunning(),
      status: answer("status"),
      agents: answer("agents"),
      blocked: answer("blocked"),
      review: answer("review"),
      tickets: mission.tickets.map((ticket) => `${ticket.ref} ${ticket.title}`),
      ticketTreeAccepted: mission.ticketTreeAccepted,
    };
  }

  /** Actions report their own result; questions use the model's answer, which is grounded in the context above. */
  private async respond(interpreted: InterpretedCommand): Promise<void> {
    if (interpreted.language) this.language = interpreted.language;
    const checked = validateIntent(interpreted.intent);
    if (!checked.ok) {
      this.say(await this.localize(checked.reason), "answer", "IMPORTANT");
      return;
    }
    if (!ACTIONS.has(checked.intent.name) && interpreted.reply) {
      if (checked.intent.name === "evidence") this.host.showEvidence();
      this.say(interpreted.reply, "answer", "IMPORTANT");
      return;
    }
    const reply = await this.act(checked.intent);
    if (reply) this.say(await this.localize(reply), "answer", "IMPORTANT");
  }

  /** An English sentence in the person's language, when they are not speaking English. */
  private async localize(text: string): Promise<string> {
    const translate = this.providers.intent.translate;
    if (this.language === "en" || !translate) return text;
    try {
      return await translate.call(this.providers.intent, text, this.language);
    } catch {
      return text;
    }
  }

  // ------------------------------------------------------------------------------------------------ commands

  private async act(intent: JarvisIntent): Promise<string | null> {
    const plane = this.host.plane();
    const mission = this.activeMission();
    const events = mission ? plane.events(mission.id) : [];
    const next = mission ? safe(() => plane.recommend(mission.id)) : null;
    try {
      switch (intent.name) {
        case "create_mission": {
          if (this.host.autopilotRunning()) return "The autopilot is running another mission. Stop it before starting a new one.";
          const created = plane.createMission(intent.idea ?? "");
          this.host.startAutopilot();
          return `Starting mission ${created.id}.`;
        }
        case "continue":
          if (!mission) return answerQuestion("status", null, [], null);
          if (this.host.autopilotRunning()) return "The autopilot is already running.";
          this.host.startAutopilot();
          return "Continuing the mission.";
        case "stop":
          if (!mission) return answerQuestion("status", null, [], null);
          if (!this.host.autopilotRunning()) return "Nothing is running.";
          this.host.stopAutopilot(mission.id);
          return "The autopilot will stop after the current step.";
        case "pause": {
          if (!mission) return answerQuestion("status", null, [], null);
          if (this.host.autopilotRunning()) this.host.stopAutopilot(mission.id);
          plane.pauseMission(mission.id);
          return "Mission paused after the current step.";
        }
        case "resume": {
          if (!mission) return answerQuestion("status", null, [], null);
          if (mission.loop === "blocked" || mission.loop === "failed") plane.resumeMission(mission.id);
          if (!this.host.autopilotRunning()) this.host.startAutopilot();
          return "Mission resumed.";
        }
        case "evidence":
          this.host.showEvidence();
          return answerQuestion("evidence", mission, events, next);
        case "accept_tickets":
          if (!mission) return answerQuestion("status", null, [], null);
          return this.host.acceptTickets();
        case "approve_release":
          if (!mission) return answerQuestion("status", null, [], null);
          return this.host.approveRelease(intent.reason ?? "");
        case "exit_jarvis":
          this.say("Jarvis offline.", "answer", "IMPORTANT");
          await this.flush();
          this.deactivate();
          return null;
        default:
          return answerQuestion(intent.name, mission, events, next);
      }
    } catch (error) {
      return `I can't do that: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ------------------------------------------------------------------------------------------------ events

  /** Watches the control plane's event logs. Existing lines are skipped so nothing old is re-narrated. */
  private connect(): Availability {
    const missions = path.join(this.host.root, ".bmad-next", "missions");
    try {
      fs.mkdirSync(missions, { recursive: true });
      for (const id of fs.readdirSync(missions)) {
        const file = path.join(missions, id, "events.jsonl");
        if (fs.existsSync(file)) this.offsets.set(file, fs.statSync(file).size);
      }
      this.watcher = fs.watch(missions, { recursive: true }, (_type, name) => {
        if (name && String(name).endsWith("events.jsonl")) this.readEvents(path.join(missions, String(name)));
      });
      return { ok: true, reason: `Watching ${path.relative(this.host.root, missions)}` };
    } catch (error) {
      return { ok: false, reason: `Could not watch mission events: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private disconnect(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Reads lines appended since the last read. Exposed for tests; the watcher calls it on every append. */
  readEvents(file: string): DomainEvent[] {
    if (!fs.existsSync(file)) return [];
    const size = fs.statSync(file).size;
    const from = this.offsets.get(file) ?? 0;
    if (size <= from) return [];
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - from);
    fs.readSync(fd, buffer, 0, buffer.length, from);
    fs.closeSync(fd);
    const text = buffer.toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    this.offsets.set(file, from + Buffer.byteLength(text.slice(0, complete)));
    const events = text
      .slice(0, complete)
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as DomainEvent];
        } catch {
          return [];
        }
      });
    for (const event of events) this.handle(event);
    this.publish();
    return events;
  }

  private handle(event: DomainEvent): void {
    if (!this.narrated.firstTime(event.id)) return;
    if (this.machine.state === "JARVIS_PAUSED" || !this.machine.on) return;
    let mission: Mission;
    try {
      mission = this.host.plane().mission(event.missionId);
    } catch {
      return;
    }
    const narration = narrateEvent(event, mission);
    if (!shouldSpeak(narration.category, this.settings.narration)) return;
    if (this.language === "en") {
      this.say(narration.text, "narration", narration.category);
      return;
    }
    // Updates keep their order while each is put into the person's language.
    this.narrationChain = this.narrationChain.then(async () => this.say(await this.localize(narration.text), "narration", narration.category));
  }

  // ------------------------------------------------------------------------------------------------ speech

  /** Transcript and speech carry the same sentence. Speech waits while the user is talking. */
  private say(text: string, kind: TranscriptEntry["kind"], category: NarrationCategory): void {
    this.record("jarvis", text, kind, category);
    if (this.machine.state === "JARVIS_PAUSED" || !this.machine.on) return;
    if (this.settings.voiceOutput === "off" || !this.providers.output?.availability().ok) return;
    this.queue.push({ text, language: this.language });
    this.drain();
  }

  private drain(): void {
    if (this.speaking || this.queue.length === 0) return;
    if (!["JARVIS_ACTIVE", "JARVIS_SPEAKING"].includes(this.machine.state)) return;
    const next = this.queue.shift() as { text: string; language: string };
    const output = this.providers.output;
    if (!output) return;
    this.speaking = true;
    this.machine.to("JARVIS_SPEAKING");
    output
      .speak(next.text, next.language)
      .catch((error: unknown) => {
        this.queue.length = 0;
        this.record("jarvis", `Speech output failed: ${error instanceof Error ? error.message : String(error)} Narration continues as text.`, "error", "ERROR");
      })
      .finally(() => {
        this.speaking = false;
        if (this.machine.state === "JARVIS_SPEAKING") this.machine.to("JARVIS_ACTIVE");
        this.drain();
      });
  }

  /** Resolves when queued speech has finished. */
  async flush(): Promise<void> {
    for (let wait = 0; wait < 200 && (this.speaking || this.queue.length > 0); wait += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // ------------------------------------------------------------------------------------------------ view

  snapshot(): JarvisSnapshot {
    const mission = safe(() => this.activeMission());
    const events = mission ? safe(() => this.host.plane().events(mission.id)) ?? [] : [];
    const agents = mission ? deriveAgents(events, mission) : { active: [], recent: [] };
    const report = mission ? evaluateRelease(mission, (file) => fs.existsSync(file)) : null;
    const open = report?.criteria.filter((item) => item.state !== "pass" && item.state !== "waived") ?? [];
    const approvalOnly = report !== null && open.length > 0 && open.every((item) => item.id === "human-release");
    return {
      state: this.machine.state,
      paused: this.machine.state === "JARVIS_PAUSED",
      readiness: this.readiness,
      voice: this.voiceAvailability(),
      microphone: this.providers.input?.availability() ?? { ok: false, reason: "No microphone provider." },
      narration: { ...this.narrationAvailability(), level: this.settings.narration },
      autoListen: this.settings.autoListen,
      mission: mission && report ? { id: mission.id, title: mission.title, phase: mission.phase, loop: mission.loop, release: report.state } : null,
      agents: agents.active,
      recent: agents.recent,
      timeline: mission ? deriveTimeline(events, mission) : [],
      transcript: this.transcript.slice(-60),
      completion:
        report && (report.state === "pass" || approvalOnly)
          ? { gates: report.criteria.filter((item) => item.id !== "human-release").map((item) => ({ label: item.label, state: item.state })), release: report.state === "pass" ? "RELEASED" : "READY FOR APPROVAL" }
          : null,
      error: this.error,
      listen: { ...this.listen, available: Boolean(this.providers.continuous && this.providers.transcriber?.availability().ok) },
      language: this.language,
    };
  }

  private publish(): void {
    this.onUpdate(this.snapshot());
  }

  private record(who: TranscriptEntry["who"], text: string, kind: TranscriptEntry["kind"], category?: NarrationCategory): void {
    this.transcript.push({ who, text, at: new Date().toISOString(), kind, category });
    if (this.transcript.length > 200) this.transcript = this.transcript.slice(-200);
    this.publish();
  }

  private fail(message: string): void {
    this.error = message;
    this.record("jarvis", message, "error", "ERROR");
  }

  private activeMission(): Mission | null {
    try {
      return this.host.plane().mission();
    } catch (error) {
      if (error instanceof Error && /No active mission/.test(error.message)) return null;
      throw error;
    }
  }

  private voiceAvailability(): Availability {
    return this.providers.intent.availability();
  }

  private narrationAvailability(): Availability {
    if (this.settings.narration === "off") return { ok: true, reason: "Narration is off in settings; text only." };
    if (this.settings.voiceOutput === "off") return { ok: true, reason: "Spoken output is off; narration is text only." };
    const output = this.providers.output?.availability() ?? { ok: false, reason: "No speech provider." };
    return output.ok ? { ok: true, reason: output.reason } : { ok: false, reason: `${output.reason} Narration stays in the transcript.` };
  }
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
