/// <reference lib="webworker" />
// Runs the Kola voice (a small VITS model made from the owner's own voice) on this device, in a background thread.
// The main window reads the model file through Rust and hands the bytes over: a worker cannot call Rust itself.
import * as ort from "onnxruntime-web/webgpu";
import { ortWasmPaths } from "./ortPaths";
import { kolaIds, type KolaVocab } from "./kolaText";

ort.env.wasm.wasmPaths = ortWasmPaths();
ort.env.wasm.numThreads = 1; // no cross-origin isolation inside the app, so one thread

type In =
  | { type: "load"; model: ArrayBuffer; vocab: KolaVocab }
  | { type: "cancel"; epoch: number }
  | { type: "say"; id: number; epoch: number; text: string; speed: number };

let session: ort.InferenceSession | null = null;
let vocab: KolaVocab | null = null;
let epoch = 0;
let queue: Promise<void> = Promise.resolve();

async function handle(m: Exclude<In, { type: "cancel" }>): Promise<void> {
  try {
    if (m.type === "load") {
      session = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      vocab = m.vocab;
      self.postMessage({ type: "ready" });
      return;
    }
    if (m.epoch < epoch) return void self.postMessage({ type: "skipped", id: m.id });
    if (!session || !vocab) throw new Error("The Kola voice is not loaded.");
    const ids = kolaIds(m.text, vocab);
    if (ids.length <= 1) return void self.postMessage({ type: "skipped", id: m.id });
    const t0 = performance.now();
    const input = new ort.Tensor("int64", BigInt64Array.from(ids.map((i) => BigInt(i))), [1, ids.length]);
    const lengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]);
    const [noise, length, noiseDp] = vocab.scales;
    const scales = new ort.Tensor("float32", Float32Array.from([noise, length / Math.min(1.5, Math.max(0.6, m.speed)), noiseDp]), [3]);
    const out = await session.run({ input, input_lengths: lengths, scales });
    const samples = (out.output ?? Object.values(out)[0]).data as Float32Array;
    const copy = new Float32Array(samples); // the runtime owns the original buffer
    self.postMessage(
      { type: "audio", id: m.id, samples: copy, rate: vocab.sampleRate, ms: performance.now() - t0, seconds: copy.length / vocab.sampleRate },
      [copy.buffer],
    );
  } catch (err) {
    session = null;
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
