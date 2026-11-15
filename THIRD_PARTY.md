# Third-party software and models

Gizimo is built on the following. Check each source again before a commercial release: terms can change.

## Libraries (bundled in the app)

| Library | Licence | Used for |
|---|---|---|
| Tauri 2 and its plugins | Apache-2.0 / MIT | the desktop shell |
| Preact | MIT | the interface |
| three.js | MIT | 3D rendering |
| @pixiv/three-vrm | MIT | VRM avatar loading and expressions |
| Transformers.js (Hugging Face) | Apache-2.0 | on-device Whisper |
| kokoro-js | Apache-2.0 | the on-device Kokoro voice |
| ONNX Runtime Web | MIT | running small models in the app |
| Ajv | MIT | validating character files |
| reqwest, serde, tokio, keyring, sha2, chrono | MIT / Apache-2.0 | the Rust side |

## Models and files fetched at run time (not in this repository)

| Item | Source | Licence | Notes |
|---|---|---|---|
| Whisper tiny.en, base.en, small.en (ONNX) | Xenova on Hugging Face | Apache-2.0 | speech recognition in the browser engine |
| Kokoro-82M (ONNX) | onnx-community / hexgrad on Hugging Face | Apache-2.0 | on-device voice |
| openWakeWord melspectrogram and embedding models, v0.5.1 | github.com/dscripka/openWakeWord | Apache-2.0 | wake word audio features. The project's ready-made phrase models are CC-BY-NC-SA and are NOT used. |
| 100Avatars set (Rose, Robert, Mikel, Polydancer, Rabbit, Devil) | Open Source Avatars, github.com/ToxSam/open-source-avatars, hosted on Arweave | CC0-1.0 | gallery avatars |
| whisper.cpp (optional native speech engine, built locally) | github.com/ggml-org/whisper.cpp | MIT | not bundled; the user builds it |

## Not included

The author's own trained voices and speech models are private and are never part of this repository or its installers.
