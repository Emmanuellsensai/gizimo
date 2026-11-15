import { invoke } from "@tauri-apps/api/core";
import { rmsToLevel } from "../avatar/level";
import type { KolaVocab } from "./kolaText";
import { MIN_REAL_TIME } from "./kokoro";
import type { SpeakOptions, TtsEngine } from "./tts";

interface Synth {
  samples: Float32Array;
  rate: number;
  ms: number;
  seconds: number;
}

export interface KolaStatus {
  installed: boolean;
  modelMb: number;
}

/**
 * Kola's own voice, running on this PC. It only exists once the owner has installed the model files (they are
 * private, so they are never downloaded). Until it is loaded and measured fast enough, `fallback` speaks instead.
 */
export class KolaVoiceEngine implements TtsEngine {
  readonly id = "kola";
  ready = false;
  failed = false;
  /** null until the first sentence has been timed; true when this PC makes speech at least as fast as it plays. */
  speedOk: boolean | null = null;
  onStatus: ((s: { state: "idle" | "loading" | "ready" | "slow" | "missing" | "failed"; message?: string; rtf?: number }) => void) | null = null;

  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private scratch: Float32Array<ArrayBuffer> | null = null;
  private epoch = 0;
  private nextId = 1;
  private jobs = new Map<number, { resolve: (s: Synth | null) => void; reject: (e: Error) => void }>();
  private playhead = 0;
  private active = new Set<AudioBufferSourceNode>();

  constructor(private fallback: TtsEngine) {}

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  speaking(): boolean {
    return this.active.size > 0 || this.fallback.speaking();
  }

  level(): number {
    if (this.analyserNode && this.active.size > 0) {
      this.scratch ??= new Float32Array(this.analyserNode.fftSize);
      this.analyserNode.getFloatTimeDomainData(this.scratch);
      let sum = 0;
      for (const v of this.scratch) sum += v * v;
      return rmsToLevel(Math.sqrt(sum / this.scratch.length));
    }
    return this.fallback.level();
  }

  /** Reads the model through Rust, starts the worker and times one sentence. Safe to call again. */
  warm(): Promise<void> {
    this.starting ??= this.start().catch(() => undefined);
    return this.starting;
  }

  private async start(): Promise<void> {
    try {
      const status = await invoke<KolaStatus>("kola_voice_status");
      if (!status.installed) {
        this.failed = true;
        this.onStatus?.({ state: "missing" });
        return;
      }
      this.onStatus?.({ state: "loading" });
      const model = await invoke<ArrayBuffer>("kola_voice_read", { name: "model.onnx" });
      const vocab = JSON.parse(new TextDecoder().decode(await invoke<ArrayBuffer>("kola_voice_read", { name: "vocab.json" }))) as KolaVocab;
      const worker = this.ensureWorker();
      await new Promise<void>((resolve, reject) => {
        this.readyWaiter = { resolve, reject };
        worker.postMessage({ type: "load", model, vocab }, [model]);
      });
      this.ready = true;
      const s = await this.synth("Hello, I am ready to talk.", 1, Number.MAX_SAFE_INTEGER);
      if (!s) return;
      const rtf = s.seconds / (s.ms / 1000);
      this.speedOk = rtf >= MIN_REAL_TIME;
      this.onStatus?.(this.speedOk ? { state: "ready", rtf } : { state: "slow", rtf });
    } catch (e) {
      this.failed = true;
      this.onStatus?.({ state: "failed", message: String(e instanceof Error ? e.message : e) });
    }
  }

  async speak(text: string, o: SpeakOptions): Promise<void> {
    void this.warm();
    if (!(this.ready && this.speedOk === true && !this.failed)) return this.fallback.speak(text, o);
    const epoch = this.epoch;
    try {
      const s = await this.synth(text, Math.min(1.5, Math.max(0.6, o.speed)), epoch);
      if (!s || epoch !== this.epoch) return;
      await this.play(s, epoch);
    } catch {
      this.failed = true;
      return this.fallback.speak(text, o);
    }
  }

  cancel(): void {
    this.epoch++;
    this.worker?.postMessage({ type: "cancel", epoch: this.epoch });
    for (const s of this.active) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
    this.playhead = 0;
    this.fallback.cancel();
  }

  private synth(text: string, speed: number, epoch: number): Promise<Synth | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.postMessage({ type: "say", id, epoch, text, speed });
    });
  }

  private async play(s: Synth, epoch: number): Promise<void> {
    const ctx = (this.ctx ??= new AudioContext());
    if (ctx.state === "suspended") await ctx.resume();
    if (epoch !== this.epoch) return;
    if (!this.analyserNode) {
      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 512;
      this.analyserNode.connect(ctx.destination);
    }
    const buffer = ctx.createBuffer(1, s.samples.length, s.rate);
    buffer.copyToChannel(s.samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyserNode);
    const startAt = Math.max(ctx.currentTime + 0.02, this.playhead);
    this.playhead = startAt + buffer.duration;
    this.active.add(source);
    await new Promise<void>((resolve) => {
      source.onended = () => {
        this.active.delete(source);
        resolve();
      };
      source.start(startAt);
    });
  }

  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./kola.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: "ready" }
        | { type: "skipped"; id: number }
        | { type: "audio"; id: number; samples: Float32Array; rate: number; ms: number; seconds: number }
        | { type: "error"; id: number; message: string };
      if (m.type === "ready") return this.readyWaiter?.resolve();
      if (m.type === "error") {
        const err = new Error(m.message);
        this.readyWaiter?.reject(err);
        this.readyWaiter = null;
        const job = this.jobs.get(m.id);
        this.jobs.delete(m.id);
        job?.reject(err);
        return;
      }
      const job = this.jobs.get(m.id);
      this.jobs.delete(m.id);
      if (m.type === "skipped") return job?.resolve(null);
      job?.resolve({ samples: m.samples, rate: m.rate, ms: m.ms, seconds: m.seconds });
    };
    worker.onerror = (e) => {
      const err = new Error(`The Kola voice engine crashed: ${e.message || "it could not start"}`);
      this.failed = true;
      this.readyWaiter?.reject(err);
      for (const j of this.jobs.values()) j.reject(err);
      this.jobs.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }
}
