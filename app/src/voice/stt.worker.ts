/// <reference lib="webworker" />
// Runs Whisper (English) on this device in a background thread so the window never freezes while it listens.
// The model downloads once from Hugging Face and is cached by the webview.
import { pipeline } from "@huggingface/transformers";
import { configureRuntime, Tally } from "./runtime";

configureRuntime();

// Anything that escapes the handler below still reaches the window as a readable message.
self.addEventListener("unhandledrejection", (e) => {
  self.postMessage({ type: "error", id: -1, message: `Listening engine error: ${String(e.reason)}` });
});

const MODELS = {
  tiny: "Xenova/whisper-tiny.en",
  base: "Xenova/whisper-base.en",
  small: "Xenova/whisper-small.en",
} as const;
type Size = keyof typeof MODELS;

type Asr = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>;
let loaded: { size: Size; asr: Promise<Asr> } | null = null;
const tally = new Tally();

function load(size: Size): Promise<Asr> {
  if (!loaded || loaded.size !== size) {
    loaded = {
      size,
      asr: pipeline("automatic-speech-recognition", MODELS[size], {
        progress_callback: (p: { status?: string; file?: string; loaded?: number }) => {
          const mb = tally.add(p);
          if (mb !== null) self.postMessage({ type: "progress", mb });
        },
      }) as unknown as Promise<Asr>,
    };
  }
  return loaded.asr;
}

self.onmessage = async (e: MessageEvent<{ id: number; audio: Float32Array; size: Size }>) => {
  const { id, audio, size } = e.data;
  try {
    const run = await load(MODELS[size] ? size : "base");
    const t0 = performance.now();
    const out = await run(audio);
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
    self.postMessage({ type: "result", id, text, ms: performance.now() - t0 });
  } catch (err) {
    loaded = null; // let the next try start fresh
    self.postMessage({ type: "error", id, message: String(err) });
  }
};
