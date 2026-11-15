import { rmsToLevel } from "../avatar/level";
import type { SpeakOptions, TtsEngine } from "./tts";

/** British voices first: Nigerian English follows British norms far more than American. */
export const KOKORO_FEMALE = "bf_emma";
export const KOKORO_MALE = "bm_george";
export const KOKORO_DOWNLOAD_MB = 88;

export function kokoroVoiceFor(pack: string, gender?: "female" | "male"): string {
  const named = pack.startsWith("kokoro:") ? pack.slice(7) : "";
  if (/^[a-z]{2}_[a-z]+$/.test(named)) return named;
  return gender === "male" ? KOKORO_MALE : KOKORO_FEMALE;
}

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "slow" | "failed";
  mb?: number;
  message?: string;
  /** Speech made per second of work: 1.0 means exactly real time. Needs 1.0 or more to chat smoothly. */
  rtf?: number;
}

/** Below this, replies would stall between sentences, so the Windows voice is used instead. */
export const MIN_REAL_TIME = 1.0;
const NEVER_SKIPPED = Number.MAX_SAFE_INTEGER;

interface Options {
  device: "wasm" | "webgpu";
  dtype: "q8" | "fp16" | "fp32";
}

interface Synth {
  samples: Float32Array;
  rate: number;
  ms: number;
  seconds: number;
}

function readOptions(): Options {
  try {
    const device = localStorage.getItem("gizimo.tts.device") === "webgpu" ? "webgpu" : "wasm";
    const dtype = localStorage.getItem("gizimo.tts.dtype");
    const allowed = ["q8", "fp16", "fp32"];
    return { device, dtype: (allowed.includes(dtype ?? "") ? dtype : device === "webgpu" ? "fp32" : "q8") as Options["dtype"] };
  } catch {
    return { device: "wasm", dtype: "q8" };
  }
}

function rtfKey(): string {
  const o = readOptions();
  return `gizimo.tts.rtf.${o.device}.${o.dtype}`;
}

function loadRtf(): number | null {
  try {
    const v = Number(localStorage.getItem(rtfKey()));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveRtf(rtf: number): void {
  try {
    localStorage.setItem(rtfKey(), String(rtf));
  } catch {
    /* the result just will not be remembered */
  }
}

/** The Kokoro voice, running on this device. Sentences are made ahead while earlier ones are still playing. */
export class KokoroEngine implements TtsEngine {
  readonly id = "kokoro";
  onStatus: ((s: EngineStatus) => void) | null = null;
  ready = false;
  failed = false;
  /** null until a short speed test has run; true only when this PC makes speech at least as fast as it plays. */
  speedOk: boolean | null = null;
  /** Measurements of the last sentences, to see whether the voice keeps up with real time. */
  stats: { ms: number; seconds: number }[] = [];

  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private epoch = 0;
  private nextId = 1;
  private jobs = new Map<number, { resolve: (s: Synth | null) => void; reject: (e: Error) => void }>();
  private playhead = 0;
  private active = new Set<AudioBufferSourceNode>();

  /** For the avatar's mouth: a live view of the voice's loudness. */
  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  private scratch: Float32Array<ArrayBuffer> | null = null;

  speaking(): boolean {
    return this.active.size > 0;
  }

  level(): number {
    if (!this.analyserNode || this.active.size === 0) return 0;
    this.scratch ??= new Float32Array(this.analyserNode.fftSize);
    this.analyserNode.getFloatTimeDomainData(this.scratch);
    let sum = 0;
    for (const v of this.scratch) sum += v * v;
    return rmsToLevel(Math.sqrt(sum / this.scratch.length));
  }

  warm(): void {
    if (this.ready || this.failed || this.worker) return;
    const known = loadRtf();
    if (known !== null && known < MIN_REAL_TIME * 0.8) {
      // This PC was already measured as too slow: do not download the model again just to find out.
      this.speedOk = false;
      this.onStatus?.({ state: "slow", rtf: known });
      return;
    }
    this.onStatus?.({ state: "loading", mb: 0 });
    this.ensureWorker().postMessage({ type: "warm", options: readOptions() });
  }

  /** Times one short sentence. The result decides whether the app may use this voice. */
  private async calibrate(): Promise<void> {
    try {
      const s = await this.synth("Hello, I am ready to talk.", { speed: 1, lang: "en", gender: "female", pack: "kokoro" }, NEVER_SKIPPED);
      if (!s) return;
      const rtf = s.seconds / (s.ms / 1000);
      saveRtf(rtf);
      this.speedOk = rtf >= MIN_REAL_TIME;
      this.onStatus?.(this.speedOk ? { state: "ready", rtf } : { state: "slow", rtf });
    } catch {
      /* the failure was already reported through onStatus */
    }
  }

  markFailed(message: string): void {
    this.failed = true;
    this.ready = false;
    this.onStatus?.({ state: "failed", message });
  }

  async speak(text: string, o: SpeakOptions): Promise<void> {
    const epoch = this.epoch;
    const synth = await this.synth(text, o, epoch);
    if (!synth || epoch !== this.epoch) return;
    await this.play(synth, epoch);
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
  }

  private synth(text: string, o: SpeakOptions, epoch: number): Promise<Synth | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.postMessage({
        type: "say",
        id,
        epoch,
        text,
        voice: kokoroVoiceFor(o.pack, o.gender),
        speed: Math.min(1.5, Math.max(0.6, o.speed)),
        options: readOptions(),
      });
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

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: "progress"; mb: number }
        | { type: "ready" }
        | { type: "skipped"; id: number }
        | { type: "audio"; id: number; samples: Float32Array; rate: number; ms: number; seconds: number }
        | { type: "error"; id: number; message: string };
      if (m.type === "progress") return this.onStatus?.({ state: "loading", mb: m.mb });
      if (m.type === "ready") {
        this.ready = true;
        this.onStatus?.({ state: "loading", mb: KOKORO_DOWNLOAD_MB, message: "testing speed" });
        void this.calibrate();
        return;
      }
      if (m.type === "error") {
        this.markFailed(m.message);
        const job = this.jobs.get(m.id);
        this.jobs.delete(m.id);
        job?.reject(new Error(m.message));
        return;
      }
      const job = this.jobs.get(m.id);
      this.jobs.delete(m.id);
      if (m.type === "skipped") return job?.resolve(null);
      this.stats.push({ ms: m.ms, seconds: m.seconds });
      job?.resolve({ samples: m.samples, rate: m.rate, ms: m.ms, seconds: m.seconds });
    };
    worker.onerror = (e) => {
      const message = `The voice engine crashed: ${e.message || "it could not start"}`;
      this.markFailed(message);
      for (const j of this.jobs.values()) j.reject(new Error(message));
      this.jobs.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }
}

/** Uses Kokoro once it is ready, and the Windows voice until then, or if Kokoro cannot run at all. */
export class AutoEngine implements TtsEngine {
  readonly id = "auto";
  private osTail: Promise<void> = Promise.resolve();

  constructor(
    private kokoro: KokoroEngine,
    private os: TtsEngine,
  ) {}

  async speak(text: string, o: SpeakOptions): Promise<void> {
    if (this.kokoro.ready && this.kokoro.speedOk === true && !this.kokoro.failed) {
      await this.osTail; // never talk over a sentence the Windows voice is still saying
      try {
        await this.kokoro.speak(text, o);
        return;
      } catch (e) {
        this.kokoro.markFailed(String(e instanceof Error ? e.message : e));
      }
    }
    this.osTail = this.os.speak(text, o);
    await this.osTail;
  }

  cancel(): void {
    this.kokoro.cancel();
    this.os.cancel();
    this.osTail = Promise.resolve();
  }

  level(): number {
    return Math.max(this.kokoro.level(), this.os.level());
  }

  speaking(): boolean {
    return this.kokoro.speaking() || this.os.speaking();
  }
}
