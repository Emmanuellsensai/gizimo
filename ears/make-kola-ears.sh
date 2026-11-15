#!/usr/bin/env bash
# Builds Gizimo's native "Kola ears" from your own model kola-asr-v2 (Whisper large-v3-turbo fine-tuned).
# Conversion only, no training. Run it in a terminal from this folder:  bash make-kola-ears.sh
# It needs: a Hugging Face login that can read your private repo (step 1), about 4 GB of free disk, and some patience.
set -e
cd "$(dirname "$0")"
PY=./venv/Scripts/python.exe
HF=./venv/Scripts/hf.exe
USER_REPO="${KOLA_HF_REPO:?Set KOLA_HF_REPO to your private models repository, for example: export KOLA_HF_REPO=youraccount/your-models-repo}"
OUT="$APPDATA/app.gizimo.desktop/ears"

echo "== 1. Hugging Face login (paste a READ token for your account when asked; it stays on this PC) =="
$HF auth whoami >/dev/null 2>&1 || $HF auth login

echo "== 2. Download kola-asr-v2 from $USER_REPO (about 1.6 GB) =="
$PY - <<PYEOF
from huggingface_hub import snapshot_download
snapshot_download("$USER_REPO", allow_patterns=["runs/asr/kola-asr-v2/*"], local_dir="kola-hf")
print("downloaded")
PYEOF
MODEL=kola-hf/runs/asr/kola-asr-v2
ls "$MODEL"

echo "== 3. Fill in tokenizer files the model folder may lack, from the public base model =="
$PY - <<PYEOF
import shutil, os
from huggingface_hub import snapshot_download
base = snapshot_download("openai/whisper-large-v3-turbo",
        allow_patterns=["vocab.json", "added_tokens.json", "merges.txt", "normalizer.json", "tokenizer.json", "preprocessor_config.json", "special_tokens_map.json", "tokenizer_config.json"])
for name in os.listdir(base):
    dst = os.path.join("$MODEL", name)
    if not os.path.exists(dst):
        shutil.copy(os.path.join(base, name), dst)
        print("added", name)
PYEOF

echo "== 4. Convert to whisper.cpp format (float16) =="
mkdir -p converted
$PY whisper.cpp/models/convert-h5-to-ggml.py "$MODEL" whisper-repo converted
ls -la converted

echo "== 5. Shrink it (5-bit) so it is about a third of the size and faster =="
./whisper.cpp/build/bin/whisper-quantize.exe converted/ggml-model.bin kola-q5_0.bin q5_0

echo "== 6. Install into Gizimo =="
mkdir -p "$OUT"
cp kola-q5_0.bin "$OUT/model.bin"
cp whisper.cpp/build/bin/whisper-server.exe "$OUT/"
ls -la "$OUT"
echo "Done. Restart Gizimo: Chat > Ears > Kola ears (this PC)."
