import type { PackManifest } from "../voice/packs";

// The two small models the wake word needs, from the openWakeWord project (Apache-2.0, github.com/dscripka/openWakeWord,
// release v0.5.1). Each is accepted only if it matches the SHA-256 recorded here.
export const WAKE_PACK: PackManifest = {
  id: "openwakeword-features",
  version: "0.5.1",
  lang: "none",
  license: "Apache-2.0",
  credit: "openWakeWord melspectrogram and speech embedding models by David Scripka (embedding derived from Google speech_embedding)",
  files: [
    {
      name: "melspectrogram.onnx",
      url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
      sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
      size: 1087958,
    },
    {
      name: "embedding_model.onnx",
      url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
      sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
      size: 1326578,
    },
  ],
};
