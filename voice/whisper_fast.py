#!/usr/bin/env python3
"""whisper-cli wrapper for Hermes's command STT provider: same args, plus -ac sized to the clip (whisper pays a
fixed 30 s encoder window otherwise). ac = 50 frames/s * duration + 150 margin, capped at 1500 (= full window), so
the whole clip is always covered. Any problem reading the WAV -> plain call.

Point it at your whisper.cpp build with WHISPER_CLI (default: `whisper-cli` on PATH). Hermes config.yaml example:
  stt:
    provider: whispercpp
    providers:
      whispercpp:
        type: command
        command: python3 /path/to/retro-mac/voice/whisper_fast.py -m /path/to/models/ggml-base.en.bin -t 2 -f {input_path} -otxt -of {output_dir}/transcript -nt -np -ng
        format: txt
"""
import os
import shutil
import sys
import wave

CLI = os.path.expanduser(os.environ.get("WHISPER_CLI") or shutil.which("whisper-cli") or "whisper-cli")
args = sys.argv[1:]
extra = []
try:
    f = args[args.index("-f") + 1]
    w = wave.open(f)
    d = w.getnframes() / float(w.getframerate())
    if "-ac" not in args:
        extra = ["-ac", str(min(1500, int(d * 50) + 150))]
except Exception:
    pass
os.execv(CLI, [CLI] + args + extra)
