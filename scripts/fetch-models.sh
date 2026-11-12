#!/bin/bash
# Download the models Retro Mac uses. Nothing here is bundled in the repo (licenses + size); every file is
# fetched from its upstream and checked against a pinned SHA-256.
#
#   scripts/fetch-models.sh            voices only (Piper, ~190 MB): real speech instead of beep-speak.
#                                      The server also needs Piper itself: venv/bin/pip install -r requirements-voice.txt
#   scripts/fetch-models.sh --wake     + the wake-word model (sherpa-onnx KWS, ~18 MB)
#   scripts/fetch-models.sh --stt      + Whisper base.en for Hermes speech-to-text (whisper.cpp, ~148 MB)
#   scripts/fetch-models.sh --all      everything
#
# Licenses (check them yourself before any commercial use; see README "Models and licenses"):
#   en_GB-alan-medium  Piper voice (rhasspy/piper-voices v1.0.0). Dataset: Alan Pope voice from Mycroft mimic3-voices
#                      (repo CC BY-SA 4.0; that voice's own LICENSE file says "All Rights Reserved"). Personal use.
#   en_US-amy-medium   Piper voice (v1.0.0). Dataset: Mycroft mimic3-voices ("see URL" upstream). Personal use.
#   en_US-joe-medium   Piper voice (v1.0.0). Dataset: NabuCasa voice-datasets, CC0.
#   sherpa-onnx KWS zipformer gigaspeech 3.3M (2024-01-01): Apache-2.0.
#   whisper ggml-base.en: MIT (OpenAI Whisper weights, converted by whisper.cpp).
set -euo pipefail
cd "$(dirname "$0")/.."
WANT_WAKE=0; WANT_STT=0
for a in "$@"; do case "$a" in --wake) WANT_WAKE=1 ;; --stt) WANT_STT=1 ;; --all) WANT_WAKE=1; WANT_STT=1 ;;
  -h|--help) sed -n 2,18p "$0"; exit 0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

get() {  # url dest sha256
  local url=$1 dest=$2 want=$3
  if [ -s "$dest" ] && [ "$(sha "$dest")" = "$want" ]; then echo "ok    $dest"; return; fi
  echo "fetch $dest"
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$url"
  local got; got=$(sha "$dest.part")
  if [ "$got" != "$want" ]; then rm -f "$dest.part"; echo "SHA-256 mismatch for $dest ($got)" >&2; exit 1; fi
  mv "$dest.part" "$dest"
}

PV=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0
get $PV/en/en_GB/alan/medium/en_GB-alan-medium.onnx      voices/en_GB-alan-medium.onnx      0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330
get $PV/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json voices/en_GB-alan-medium.onnx.json c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e
get $PV/en/en_US/amy/medium/en_US-amy-medium.onnx        voices/en_US-amy-medium.onnx       b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18
get $PV/en/en_US/amy/medium/en_US-amy-medium.onnx.json   voices/en_US-amy-medium.onnx.json  95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77
get $PV/en/en_US/joe/medium/en_US-joe-medium.onnx        voices/en_US-joe-medium.onnx       58afce0321b8d9c46d7cdf9c16500cc55a793b4220212dba6b70fb788b3baf06
get $PV/en/en_US/joe/medium/en_US-joe-medium.onnx.json   voices/en_US-joe-medium.onnx.json  3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33

if [ "$WANT_WAKE" = 1 ]; then
  K=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
  if [ -s "models/$K/tokens.txt" ]; then echo "ok    models/$K"; else
    get https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$K.tar.bz2 models/$K.tar.bz2 \
        f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a
    tar xjf "models/$K.tar.bz2" -C models && rm -f "models/$K.tar.bz2"
  fi
fi

if [ "$WANT_STT" = 1 ]; then
  get https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin models/ggml-base.en.bin \
      a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
fi
PY=${PYTHON:-venv/bin/python}; [ -x "$PY" ] || PY=python3
if ! "$PY" -c 'import piper' 2>/dev/null; then
  echo "note: piper-tts is not installed for $PY, so the server will still beep-speak."
  echo "      install it: venv/bin/pip install -r requirements-voice.txt"
fi
echo "done. Restart the server to load the voices."
