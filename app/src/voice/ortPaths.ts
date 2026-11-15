// Where the ONNX runtime's two files live inside the app. Vite copies them in, so nothing loads from a CDN.
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import mjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";

/** Absolute addresses, for use inside a worker. */
export function ortWasmPaths(): { mjs: string; wasm: string } {
  return {
    mjs: new URL(mjsUrl, self.location.href).href,
    wasm: new URL(wasmUrl, self.location.href).href,
  };
}
