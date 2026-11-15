// Shared set-up for the on-device AI workers (voice and ears). Runs inside a worker.
import { env } from "@huggingface/transformers";
import { ortWasmPaths } from "./ortPaths";

export function configureRuntime(): void {
  env.allowLocalModels = false;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = ortWasmPaths();
}

/** Adds up download progress across the several files of a model: megabytes so far. */
export class Tally {
  private files = new Map<string, number>();

  add(p: { status?: string; file?: string; loaded?: number }): number | null {
    if (p.status !== "progress" || !p.file) return null;
    this.files.set(p.file, p.loaded ?? 0);
    let total = 0;
    for (const n of this.files.values()) total += n;
    return Math.round(total / 1048576);
  }
}
