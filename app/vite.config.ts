import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [preact()],

  // The listening worker is only loaded when you first press Talk. Without this, the dev server would discover
  // the speech library at that moment, re-optimize it and reload the page, killing the worker while it starts.
  optimizeDeps: {
    include: [
      "@huggingface/transformers",
      "kokoro-js",
      "phonemizer",
      "onnxruntime-web/webgpu",
      "three",
      "three/addons/loaders/GLTFLoader.js",
      "@pixiv/three-vrm",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
