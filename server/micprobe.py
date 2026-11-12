#!/usr/bin/env python3
"""Who holds the microphone open right now (macOS), read-only.

CoreAudio keeps a power assertion while any process has a live input stream on the built-in mic:
`pmset -g assertions` lists it under coreaudiod as "com.apple.audio.AppleHDAEngineInput..." followed by
"Created for PID: n". lsof cannot see CoreAudio, so this is the cheapest honest signal that the device is open.
On Linux (or if pmset is missing) every function here returns an empty list: a no-op, never an alert.

  python3 server/micprobe.py [--exclude PID ...]     prints "pid hh:mm:ss" per holder, exit 0
"""
import re
import subprocess
import sys

INPUT_RE = re.compile(r"AppleHDAEngineInput|EngineInput", re.I)
ASSERT_RE = re.compile(r"^\s*pid \d+\([^)]*\):\s*\[[^\]]*\]\s*(\d+:\d{2}:\d{2})\s")
CREATED_RE = re.compile(r"Created for PID:\s*(\d+)")


def parse_assertions(text: str) -> list:
    """`pmset -g assertions` text -> [{"pid": int, "for": "hh:mm:ss"}] for mic input assertions (one per pid)."""
    out, cur = [], None
    for line in str(text or "").splitlines():
        if ASSERT_RE.match(line):
            cur = None
            if INPUT_RE.search(line):
                cur = {"pid": None, "for": ASSERT_RE.match(line).group(1)}
            continue
        m = CREATED_RE.search(line)
        if m and cur is not None and cur["pid"] is None:
            cur["pid"] = int(m.group(1))
            if all(h["pid"] != cur["pid"] for h in out):
                out.append(cur)
    return out


def mic_holders(exclude=()) -> list:
    if sys.platform != "darwin":
        return []
    try:
        text = subprocess.run(["pmset", "-g", "assertions"], capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return []
    skip = {int(p) for p in exclude if str(p).isdigit()}
    return [h for h in parse_assertions(text) if h["pid"] not in skip]


if __name__ == "__main__":
    ex = [a for a in sys.argv[1:] if a != "--exclude"]
    for h in mic_holders(ex):
        print(h["pid"], h["for"])
