#!/usr/bin/env bash
# Speed test BEFORE converting your own model: downloads the public Whisper large-v3-turbo (the same size and design as
# kola-asr-v2, 5-bit) and times it on a spoken sentence on this PC. Run:  bash bench-turbo.sh
set -e
cd "$(dirname "$0")"
mkdir -p bench
if [ ! -f bench/ggml-large-v3-turbo-q5_0.bin ]; then
  ./venv/Scripts/python.exe - <<'PYEOF'
from huggingface_hub import hf_hub_download
p = hf_hub_download("ggerganov/whisper.cpp", "ggml-large-v3-turbo-q5_0.bin", local_dir="bench")
print("downloaded", p)
PYEOF
fi
# a 5-second test sentence spoken by a Windows voice
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$s.SetOutputToWaveFile((Resolve-Path bench).Path + '\\test.wav', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono))); \$s.Speak('Hello Gizimo, please remind me to call my mother at five o clock.'); \$s.Dispose()"
echo "== timing (threads: 4) =="
./whisper.cpp/build/bin/whisper-cli.exe -m bench/ggml-large-v3-turbo-q5_0.bin -f bench/test.wav -l en -t 4 -nt 2>&1 | grep -E "load time|total time|encode time|decode time|Hello|remind" || true
