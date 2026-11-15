/// <reference lib="webworker" />
// Runs the Kokoro voice (82M parameters, Apache-2.0) on this device, in a background thread.
// Jobs run one at a time, in order. A cancel message makes every older queued job skip itself.
import { KokoroTTS } from "kokoro-js";
import { configureRuntime, Tally } from "./runtime";

configureRuntime();

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

interface Options {
  device: "wasm" | "webgpu";
  dtype: "q8" | "fp16" | "fp32";
}

type In =
  | { type: "warm"; options: Options }
  | { type: "cancel"; epoch: number }
  | { type: "say"; id: number; epoch: number; text: string; voice: string; speed: number; options: Options };

let model: Promise<KokoroTTS> | null = null;
let epoch = 0;
let queue: Promise<void> = Promise.resolve();
const tally = new Tally();

function load(options: Options): Promise<KokoroTTS> {
  model ??= KokoroTTS.from_pretrained(MODEL, {
    dtype: options.dtype,
    device: options.device,
    progress_callback: (p: { status?: string; file?: string; loaded?: number }) => {
      const mb = tally.add(p);
      if (mb !== null) self.postMessage({ type: "progress", mb });
    },
  });
  return model;
}

async function handle(m: Exclude<In, { type: "cancel" }>): Promise<void> {
  try {
    const tts = await load(m.options);
    if (m.type === "warm") {
      self.postMessage({ type: "ready" });
      return;
    }
    if (m.epoch < epoch) return void self.postMessage({ type: "skipped", id: m.id });
    const t0 = performance.now();
    const audio = await tts.generate(m.text, { voice: m.voice as never, speed: m.speed });
    const samples = audio.audio as Float32Array;
    const seconds = samples.length / audio.sampling_rate;
    self.postMessage(
      { type: "audio", id: m.id, samples, rate: audio.sampling_rate, ms: performance.now() - t0, seconds },
      [samples.buffer],
    );
  } catch (err) {
    model = null; // let the next try start fresh
    self.postMessage({ type: "error", id: m.type === "say" ? m.id : -1, message: String(err instanceof Error ? err.message : err) });
  }
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "cancel") {
    epoch = m.epoch;
    return;
  }
  queue = queue.then(() => handle(m));
};
