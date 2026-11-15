import { installPack, readPackFile } from "../voice/packs";
import { WAKE_PACK } from "./models";
import { mean, suggestThreshold, type Embedding } from "./match";
import captureUrl from "./capture.worklet.ts?worker&url";

export interface WakeConfig {
  templates: number[][][]; // recordings of the phrase, each a list of 96-number frames
  threshold: number;
}

/** Always-listening wake phrase: the microphone feeds a small on-device model, and nothing is recorded or sent anywhere. */
export class WakeEngine {
  onWake: (() => void) | null = null;
  onScore: ((score: number, speaking: boolean) => void) | null = null;
  onStatus: ((message: string) => void) | null = null;

  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private paused = false;
  private recordResolve: ((frames: Embedding[]) => void) | null = null;
  private ready: Promise<void> | null = null;

  get running(): boolean {
    return !!this.stream;
  }

  /** Downloads the two models once, starts the worker and the microphone. */
  async start(config: WakeConfig | null): Promise<void> {
    if (this.running) return;
    await this.load();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule(captureUrl);
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "gizimo-capture");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.paused) this.worker?.postMessage({ type: "audio", samples: e.data }, [e.data.buffer]);
    };
    source.connect(node); // the node is never connected to the speakers, so you do not hear yourself
    if (config) this.configure(config);
    this.onStatus?.("");
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  /** Stop listening for a moment (Gizi is talking, or you are giving a command) without closing the microphone. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) this.worker?.postMessage({ type: "reset" }); // forget what was heard before, so it cannot trigger on it
  }

  configure(config: WakeConfig): void {
    const templates = config.templates.map((t) => t.map((f) => Float32Array.from(f)));
    const all = templates.flat();
    const offset = all.length ? mean(all) : new Float32Array(96);
    this.worker?.postMessage({ type: "templates", templates, offset, threshold: config.threshold });
  }

  /** A sensible threshold for a set of recordings. */
  static suggest(templates: number[][][]): number {
    const t = templates.map((r) => r.map((f) => Float32Array.from(f)));
    const all = t.flat();
    return all.length ? suggestThreshold(t, mean(all)) : 0.7;
  }

  /** Records the wake phrase for a few seconds and returns its frames (empty if nothing was said). */
  async record(ms = 2400): Promise<Embedding[]> {
    if (!this.running) throw new Error("Start listening first.");
    this.worker?.postMessage({ type: "record" });
    await new Promise((r) => setTimeout(r, ms));
    return new Promise((resolve) => {
      this.recordResolve = resolve;
      this.worker?.postMessage({ type: "stopRecord" });
    });
  }

  private load(): Promise<void> {
    this.ready ??= (async () => {
      this.onStatus?.("Getting the wake word models (one-time download, about 2.4 MB)...");
      await installPack(WAKE_PACK, (p) => this.onStatus?.(`Downloading the wake word models: ${p}%`));
      const [mel, embedding] = await Promise.all(WAKE_PACK.files.map((f) => readPackFile(WAKE_PACK.id, WAKE_PACK.version, f.name)));
      const worker = new Worker(new URL("./wake.worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          const m = e.data as { type: string; score?: number; speaking?: boolean; frames?: Embedding[]; message?: string };
          if (m.type === "ready") resolve();
          else if (m.type === "error") reject(new Error(m.message));
          else if (m.type === "score") this.onScore?.(m.score ?? -1, !!m.speaking);
          else if (m.type === "wake") this.onWake?.();
          else if (m.type === "recorded") {
            this.recordResolve?.(m.frames ?? []);
            this.recordResolve = null;
          }
        };
        worker.onerror = (e) => reject(new Error(e.message || "The wake word engine could not start"));
        worker.postMessage({ type: "init", mel, embedding });
      });
    })().catch((e) => {
      this.ready = null;
      this.worker?.terminate();
      this.worker = null;
      throw e;
    });
    return this.ready;
  }
}

/** A short rising two-note chime, so you know Gizi heard you. */
export function chime(): void {
  try {
    const ctx = new AudioContext();
    const t0 = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.22);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* no sound is fine */
  }
}
