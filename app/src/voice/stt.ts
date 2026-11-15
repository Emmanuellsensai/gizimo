import { invoke } from "@tauri-apps/api/core";

const MAX_SECONDS = 30; // Whisper reads 30 seconds at a time
const MIN_SECONDS = 0.4;
const SILENCE_RMS = 0.002;

interface Waiting {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/** Whisper writes things like [BLANK_AUDIO] or (silence) when it hears nothing. */
export function isNoise(text: string): boolean {
  const t = text.trim();
  return t === "" || /^[[(].*[\])]$/.test(t);
}

async function toMono16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const out = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / decoded.numberOfChannels;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow it in Windows Settings > Privacy & security > Microphone, then try again.";
  }
  if (name === "NotFoundError") return "No microphone was found.";
  return `Could not start the microphone: ${String(e)}`;
}

/** Records from the microphone, then turns the recording into text on this device. */
export class Listener {
  /** Megabytes of the one-time model download so far (about 40 in all), or null when nothing is downloading. */
  onProgress: ((percent: number | null) => void) | null = null;

  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  /** Which Whisper size listens. Bigger hears accents better but is slower and downloads more. */
  size: EarsSize = loadEarsSize();
  /** How long the last transcription took, in milliseconds (for tuning). */
  lastMs = 0;
  /** The character's language (en, pcm, yo, ig, ha). Only the Kola ears use it. */
  lang = "en";

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private limitTimer: number | undefined;

  private vadTimer: number | undefined;
  private vadCtx: AudioContext | null = null;

  /**
   * Starts recording. `onLimit` is called when the time limit is reached, and, with `autoStop`, also when the speaker
   * falls silent after talking (or says nothing for 7 seconds), so a spoken command ends by itself.
   */
  async start(onLimit: () => void, options?: { autoStop?: boolean }): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();
    this.limitTimer = window.setTimeout(onLimit, MAX_SECONDS * 1000);

    if (options?.autoStop) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(this.stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const began = performance.now();
      let lastLoud = began;
      let spoke = false;
      this.vadCtx = ctx;
      this.vadTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const now = performance.now();
        if (rms(samples) > 0.02) {
          spoke = true;
          lastLoud = now;
        }
        if ((spoke && now - lastLoud > 1300) || (!spoke && now - began > 7000)) {
          window.clearInterval(this.vadTimer);
          onLimit();
        }
      }, 100);
    }
  }

  /** Stops recording and returns what was said ("" when nothing was heard). */
  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") {
        this.release();
        return resolve("");
      }
      recorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType });
        this.release();
        try {
          const pcm = await toMono16k(blob);
          if (pcm.length < 16000 * MIN_SECONDS || rms(pcm) < SILENCE_RMS) return resolve("");
          const text = await this.transcribe(pcm.subarray(0, 16000 * MAX_SECONDS));
          resolve(isNoise(text) ? "" : text);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      recorder.stop();
    });
  }

  /** Abandon the recording without transcribing it. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release(): void {
    window.clearTimeout(this.limitTimer);
    window.clearInterval(this.vadTimer);
    void this.vadCtx?.close();
    this.vadCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }

  transcribe(audio: Float32Array): Promise<string> {
    if (this.size === "kola") return this.transcribeNative(audio);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, audio: audio.slice(), size: this.size }); // a copy, so the worker never sees the whole recording buffer
    });
  }

  /** The Kola ears: your own model, run natively on this PC. */
  private async transcribeNative(audio: Float32Array): Promise<string> {
    const t0 = performance.now();
    const bytes = new Uint8Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
    const text = await invoke<string>("ears_transcribe", bytes, { headers: { language: this.lang } });
    this.lastMs = performance.now() - t0;
    this.onProgress?.(null);
    return text;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./stt.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: "progress"; mb: number }
        | { type: "result"; id: number; text: string; ms: number }
        | { type: "error"; id: number; message: string };
      if (m.type === "progress") return this.onProgress?.(m.mb);
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      this.onProgress?.(null);
      if (!w) return;
      if (m.type === "result") {
        this.lastMs = m.ms;
        w.resolve(m.text);
      } else w.reject(new Error(m.message));
    };
    worker.onerror = (e) => {
      const where = e.filename ? ` (${e.filename.split("/").slice(-2).join("/")}:${e.lineno})` : "";
      for (const w of this.waiting.values()) w.reject(new Error(`The listening engine crashed: ${e.message || "it could not start"}${where}`));
      this.waiting.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

}

export type EarsSize = "tiny" | "base" | "small" | "kola";
/** One-time download sizes in megabytes (quantized files on Hugging Face). */
export const EARS_MB: Record<EarsSize, number> = { tiny: 39, base: 73, small: 238, kola: 0 };

export function loadEarsSize(): EarsSize {
  try {
    const v = localStorage.getItem("gizimo.ears");
    if (v === "tiny" || v === "base" || v === "small" || v === "kola") return v;
  } catch {
    /* use the default */
  }
  return "tiny"; // measured on a modest laptop: tiny 6 s, base 11 s for a 5 s sentence, and no better on that sample
}

export function saveEarsSize(size: EarsSize): void {
  try {
    localStorage.setItem("gizimo.ears", size);
  } catch {
    /* the choice just will not be remembered */
  }
}
