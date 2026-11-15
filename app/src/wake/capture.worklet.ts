// Runs on the audio thread: collects the microphone into 80 ms blocks (1280 samples at 16 kHz) and hands them over.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const BLOCK = 1280;

class Capture extends AudioWorkletProcessor {
  private buffer = new Float32Array(BLOCK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const take = Math.min(BLOCK - this.filled, input.length - i);
      this.buffer.set(input.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === BLOCK) {
        const out = this.buffer;
        this.buffer = new Float32Array(BLOCK);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("gizimo-capture", Capture as unknown as new () => AudioWorkletProcessor);
