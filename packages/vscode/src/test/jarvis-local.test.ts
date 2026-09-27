import assert from "node:assert/strict";
import test from "node:test";
import { ContinuousMicrophone, LocalIntentProvider, WhisperService, afterWakePhrase, languageCode, localVoiceConfig, wav } from "../jarvis/local";
import type { AudioClip } from "../jarvis/providers";

test("the wake phrase is found in English and Hindi, and only as the name itself", () => {
  assert.equal(afterWakePhrase("Hey Jarvis, create a todo app"), "create a todo app");
  assert.equal(afterWakePhrase("जार्विस, टूडू ऐप बनाओ"), "टूडू ऐप बनाओ");
  assert.equal(afterWakePhrase("हे जार्विस अभी क्या चल रहा है"), "अभी क्या चल रहा है");
  assert.equal(afterWakePhrase("Jarvis."), "");
  assert.equal(afterWakePhrase("Jarvisland is a place"), null);
  assert.equal(afterWakePhrase("the jar is on the table"), null);
});

test("whisper language names become the codes speech and prompts use", () => {
  assert.equal(languageCode("hindi"), "hi");
  assert.equal(languageCode("English"), "en");
  assert.equal(languageCode("ta"), "ta");
  assert.equal(languageCode("klingon"), "en");
});

test("the local model's JSON answer carries the reply, the language, and an intent that is still validated later", async () => {
  const config = { ...localVoiceConfig({}), url: "http://model.test/v1", model: "m" };
  const sent: string[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    const content = JSON.stringify({ language: "hi", reply: "मिशन रोक रहा हूँ।", intent: { name: "stop" } });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new LocalIntentProvider(config, new WhisperService(config, () => false), fake);
  const result = await provider.interpretText("मिशन को रोक दो", { mission: { title: "Todo" } }, "hi");
  assert.deepEqual(result.intent, { name: "stop" });
  assert.equal(result.language, "hi");
  assert.equal(result.reply, "मिशन रोक रहा हूँ।");
  // The facts travel with the request, and the model is asked for JSON.
  assert.match(sent[0] ?? "", /"response_format":\{"type":"json_object"\}/);
  assert.match(sent[0] ?? "", /Todo/);
  assert.equal(provider.textReady(), true);
  assert.equal(provider.availability().ok, false);
});

test("a hosted endpoint gets its API key as a bearer token; a local one gets none", async () => {
  const headers: Array<Record<string, string>> = [];
  const fake = (async (_url: string, init: { headers: Record<string, string> }) => {
    headers.push(init.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ language: "en", reply: "ok", intent: { name: "status" } }) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const hosted = localVoiceConfig({ AI_BASE_URL: "https://api.example.test/v1", AI_API_KEY: "sk-test-123" });
  assert.equal(hosted.url, "https://api.example.test/v1");
  await new LocalIntentProvider(hosted, new WhisperService(hosted, () => false), fake).interpretText("status", {});
  const local = localVoiceConfig({});
  assert.equal(local.url, "http://127.0.0.1:11434/v1");
  await new LocalIntentProvider(local, new WhisperService(local, () => false), fake).interpretText("status", {});
  assert.equal(headers[0]?.authorization, "Bearer sk-test-123");
  assert.equal(headers[1]?.authorization, undefined);
});

test("an unreachable or garbled model is reported, not guessed around", async () => {
  const config = { ...localVoiceConfig({}), url: "http://model.test/v1", model: "m" };
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(new LocalIntentProvider(config, new WhisperService(config, () => false), down).interpretText("status", {}), /unreachable/);
  const garbled = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(new LocalIntentProvider(config, new WhisperService(config, () => false), garbled).interpretText("status", {}), /could not read/);
});

test("the open microphone cuts speech into utterances by loudness and drops audio while muted", () => {
  const mic = new ContinuousMicrophone();
  const clips: AudioClip[] = [];
  const hearing: boolean[] = [];
  const events = { onUtterance: (clip: AudioClip) => clips.push(clip), onHearing: (h: boolean) => hearing.push(h) };
  const feed = (mic as unknown as { feed(chunk: Buffer, e: typeof events): void }).feed.bind(mic);
  const tone = (ms: number, amplitude: number) => {
    const samples = (16000 * ms) / 1000;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
    return pcm;
  };
  feed(tone(600, 40), events); // room noise
  feed(tone(1200, 8000), events); // speech
  feed(tone(900, 40), events); // quiet ends it
  assert.equal(clips.length, 1);
  assert.deepEqual(hearing, [true, false]);
  assert.ok((clips[0]?.durationMs ?? 0) >= 1200);
  assert.equal(clips[0]?.data.subarray(0, 4).toString(), "RIFF");
  mic.mute(true);
  feed(tone(1200, 8000), events);
  feed(tone(900, 40), events);
  assert.equal(clips.length, 1);
});

test("a WAV header describes 16 kHz mono 16-bit audio", () => {
  const file = wav(Buffer.alloc(3200));
  assert.equal(file.length, 44 + 3200);
  assert.equal(file.readUInt32LE(24), 16000);
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt16LE(34), 16);
});
