/// <reference lib="webworker" />
// Turns 80 ms blocks of microphone audio into "embeddings" with two small models from the openWakeWord project
// (Apache-2.0), keeps a short history, and compares the latest moments with the recordings of the wake phrase.
import * as ort from "onnxruntime-web/webgpu";
import { ortWasmPaths } from "../voice/ortPaths";
import { bestScore, trimByEnergy, type Embedding } from "./match";

ort.env.wasm.wasmPaths = ortWasmPaths();

const MEL_BINS = 32;
const WINDOW = 76; // mel frames per embedding
const CONTEXT = 1280 + 160 * 3; // samples the mel model looks at for each new block
const COOLDOWN_MS = 2500;

let mel: ort.InferenceSession | null = null;
let emb: ort.InferenceSession | null = null;
let raw = new Float32Array(0);
let melRows: Float32Array[] = [];
let embeddings: Embedding[] = [];
let energy: number[] = [];
let templates: Embedding[][] = [];
let offset: Float32Array = new Float32Array(96);
let threshold = 0.7;
let lastWake = 0;
let recording: { frames: Embedding[]; energy: number[] } | null = null;
let busy = Promise.resolve();

type In =
  | { type: "init"; mel: ArrayBuffer; embedding: ArrayBuffer }
  | { type: "audio"; samples: Float32Array }
  | { type: "templates"; templates: Float32Array[][]; offset: Float32Array; threshold: number }
  | { type: "record" }
  | { type: "stopRecord" }
  | { type: "reset" };

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

function reset() {
  raw = new Float32Array(0);
  melRows = [];
  embeddings = [];
  energy = [];
}

async function block(samples: Float32Array) {
  if (!mel || !emb) return;
  // The models were trained on 16-bit integer sample values, so scale up from -1..1.
  const scaled = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) scaled[i] = samples[i] * 32768;
  const joined = new Float32Array(Math.min(CONTEXT, raw.length + scaled.length));
  const all = new Float32Array(raw.length + scaled.length);
  all.set(raw);
  all.set(scaled, raw.length);
  joined.set(all.subarray(all.length - joined.length));
  raw = joined;
  if (raw.length < CONTEXT) return;

  const melOut = await mel.run({ [mel.inputNames[0]]: new ort.Tensor("float32", raw, [1, raw.length]) });
  const data = melOut[mel.outputNames[0]].data as Float32Array;
  for (let r = 0; r + MEL_BINS <= data.length; r += MEL_BINS) {
    melRows.push(Float32Array.from(data.subarray(r, r + MEL_BINS), (v) => v / 10 + 2));
  }
  if (melRows.length > 970) melRows = melRows.slice(-970);
  if (melRows.length < WINDOW) return;

  const input = new Float32Array(WINDOW * MEL_BINS);
  melRows.slice(-WINDOW).forEach((row, i) => input.set(row, i * MEL_BINS));
  const out = await emb.run({ [emb.inputNames[0]]: new ort.Tensor("float32", input, [1, WINDOW, MEL_BINS, 1]) });
  const vector = Float32Array.from((out[emb.outputNames[0]].data as Float32Array).subarray(0, 96));
  const level = rms(samples);
  embeddings.push(vector);
  energy.push(level);
  if (embeddings.length > 120) {
    embeddings.shift();
    energy.shift();
  }
  if (recording) {
    recording.frames.push(vector);
    recording.energy.push(level);
  }

  if (templates.length) {
    const longest = Math.max(...templates.map((t) => t.length));
    const recent = embeddings.slice(-(longest + 3));
    const score = bestScore(recent, templates, offset);
    const speaking = rms(Float32Array.from(energy.slice(-8))) > 0.006; // someone is actually talking
    const now = performance.now();
    self.postMessage({ type: "score", score, speaking });
    if (score >= threshold && speaking && now - lastWake > COOLDOWN_MS) {
      lastWake = now;
      self.postMessage({ type: "wake", score });
    }
  }
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "audio") {
    busy = busy.then(() => block(m.samples)).catch((err) => self.postMessage({ type: "error", message: String(err) }));
  } else if (m.type === "init") {
    busy = busy
      .then(async () => {
        const options = { executionProviders: ["wasm"] };
        mel = await ort.InferenceSession.create(new Uint8Array(m.mel), options);
        emb = await ort.InferenceSession.create(new Uint8Array(m.embedding), options);
        self.postMessage({ type: "ready" });
      })
      .catch((err) => self.postMessage({ type: "error", message: String(err) }));
  } else if (m.type === "templates") {
    templates = m.templates;
    offset = m.offset;
    threshold = m.threshold;
  } else if (m.type === "record") {
    recording = { frames: [], energy: [] };
  } else if (m.type === "stopRecord") {
    const taken = recording;
    recording = null;
    const frames = taken ? trimByEnergy(taken.frames, taken.energy) : [];
    self.postMessage({ type: "recorded", frames });
  } else if (m.type === "reset") {
    reset();
  }
};
