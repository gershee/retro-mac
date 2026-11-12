#!/usr/bin/env python3
"""Failed-voice-turn + watchdog test, silent, no model calls, never touches the live kiosk/tmux.

Starts tests/testsrv.py on a spare port (default 8792) with FAKE_PANE pointing at a temp file, then:
  A. voice turn + real captured TUI rate-limit text appended to the fake pane -> state failed (limit, reset 11:10 PM),
     one spoken line, turn cleared, mic window released, back to idle after ~8 s
  B. second turn, generic failure text (marker wrapped over two lines; old scrollback still contains marker #1)
  C. Telegram turn (kind none) + the same text -> nothing happens
  D. POST /voice_error without a voice turn -> ignored; with kind=limit + text -> parsed
  E. watchdog (RETRO_MAC_STUCK_AFTER=3): stuck flag + ONE spoken line, activity clears it, tap (/stop) cancels it
  venv/bin/python tests/test_fail.py [port]
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("RETRO_MAC_PORT", "8792"))
BASE = f"http://127.0.0.1:{PORT}"
FIX = Path(__file__).parent / "fixtures"
FAILS = []


def call(path, body=None):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read() or b"{}")


def vs():
    return call("/voice_state")


def health():
    return call("/health")


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def wait_for(pred, secs=10.0, step=0.25):
    end = time.time() + secs
    while time.time() < end:
        v = vs()
        if pred(v):
            return v
        time.sleep(step)
    return vs()


def spoken_count(log_path, needle):
    return sum(1 for ln in Path(log_path).read_text().splitlines() if "speech #" in ln and needle in ln and "/" in ln)


def start_turn(sid, platform="tui", text="what's on my calendar"):
    call("/arm", {"secs": 600})
    return call("/voice_turn", {"agent": "alfred", "session_id": sid, "platform": platform, "text": text, "marker": True})


tmp = Path(tempfile.mkdtemp(prefix="failtest-"))
pane = tmp / "pane.txt"
pane.write_text("older scrollback\n$ hermes\n")
logf = ROOT / "data" / "logs" / "kiosk2-fail-test.log"
logf.parent.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, FAKE_PANE=str(pane), RETRO_MAC_STUCK_AFTER="3")
srv = subprocess.Popen([sys.executable, str(ROOT / "tests/testsrv.py"), str(ROOT / "server/server.py"), str(PORT)],
                       stdout=open(logf, "w"), stderr=subprocess.STDOUT, env=env, cwd=str(ROOT))
try:
    for _ in range(80):
        try:
            health()
            break
        except Exception:
            time.sleep(0.5)
    else:
        sys.exit("test server did not start")

    # ---- A: rate limit
    r = start_turn("sess-A")
    check("A turn registered as voice", r.get("kind") == "voice", r)
    time.sleep(2.5)                                    # baseline taken from the pane
    check("A working before the error", vs()["state"] == "working", vs()["state"])
    pane.write_text(pane.read_text() + (FIX / "pane_limit.txt").read_text())
    v = wait_for(lambda v: v["state"] == "failed", 8)
    check("A state failed", v["state"] == "failed", v["state"])
    check("A kind limit + reset parsed", (v.get("fail") or {}).get("kind") == "limit" and (v.get("fail") or {}).get("reset") == "11:10 PM", v.get("fail"))
    check("A banner note", v.get("note") == "TRY AGAIN AT 11:10 PM", v.get("note"))
    check("A turn cleared", v.get("turn") is None, v.get("turn"))
    h = health()
    check("A mic window released (armed false)", not v.get("armed") and h["armed_for"] == 0.0, (v.get("armed"), h["armed_for"]))
    time.sleep(3.0)
    check("A one spoken line", spoken_count(logf, "usage limit") == 1, spoken_count(logf, "usage limit"))
    check("A no follow-up mic (followup_ok false)", health()["followup_ok"] is False)
    check("A spoken text", "Try again after 11:10 PM" in logf.read_text() or "hit my usage limit" in logf.read_text())
    v = wait_for(lambda v: v["state"] == "idle", 12)
    check("A back to idle by ~8 s", v["state"] == "idle", v["state"])

    # ---- B: generic failure, old marker already in scrollback
    start_turn("sess-B")
    time.sleep(2.5)
    pane.write_text(pane.read_text() + (FIX / "pane_generic.txt").read_text())
    v = wait_for(lambda v: v["state"] == "failed", 8)
    check("B state failed", v["state"] == "failed", v["state"])
    check("B kind generic", (v.get("fail") or {}).get("kind") == "generic", v.get("fail"))
    check("B banner note", v.get("note") == "TRY AGAIN IN A MINUTE", v.get("note"))
    time.sleep(2.5)
    check("B spoken line", spoken_count(logf, "didn't work") == 1, spoken_count(logf, "didn't work"))
    wait_for(lambda v: v["state"] == "idle", 12)

    # ---- C: telegram never speaks
    n0 = health()["fail"]["count"]
    r = call("/voice_turn", {"agent": "alfred", "session_id": "tg-1", "platform": "telegram", "text": "hello", "marker": True})
    check("C telegram turn is not a voice turn", r.get("kind") == "none", r)
    time.sleep(1.5)
    pane.write_text(pane.read_text() + (FIX / "pane_limit.txt").read_text())
    time.sleep(3.0)
    check("C no failure for telegram", vs()["state"] == "idle" and health()["fail"]["count"] == n0, (vs()["state"], health()["fail"]))
    r = call("/voice_error", {"kind": "limit", "text": "Limit resets at 23:10"})
    check("D /voice_error without a voice turn is ignored", "ignored" in r, r)

    # ---- D2: endpoint with a turn and text
    start_turn("sess-D")
    r = call("/voice_error", {"session_id": "sess-D", "text": "Anthropic rate-limited every one of 3 attempts. HTTP 429. Limit resets at 07:05 (in 2h). This turn did not complete."})
    check("D /voice_error limit with AM reset", r.get("note") == "TRY AGAIN AT 7:05 AM", r)
    wait_for(lambda v: v["state"] == "idle", 12)

    # ---- E: watchdog
    s0 = spoken_count(logf, "Still trying")      # A and B also tripped the 3 s watchdog before their failure text
    start_turn("sess-E")
    v = wait_for(lambda v: (v.get("turn") or {}).get("stuck"), 8)
    check("E watchdog fires (stuck)", (v.get("turn") or {}).get("stuck") is True, v.get("turn"))
    time.sleep(2.5)
    check("E said once", spoken_count(logf, "Still trying") - s0 == 1, spoken_count(logf, "Still trying") - s0)
    call("/activity", {"agent": "alfred", "status": "working", "label": "SEARCHING", "session_id": "sess-E",
                       "caption": "SEARCHING: x", "say": "Looking.", "step": "start", "call_id": "c1"})
    check("E activity clears stuck", (vs().get("turn") or {}).get("stuck") is False, vs().get("turn"))
    v = wait_for(lambda v: (v.get("turn") or {}).get("stuck"), 8)
    time.sleep(2.0)
    check("E still only one spoken line after re-stick", spoken_count(logf, "Still trying") - s0 == 1, spoken_count(logf, "Still trying") - s0)
    call("/stop", {})
    v = wait_for(lambda v: v["state"] == "stopped", 5)
    check("E tap cancels the stuck turn", v["state"] == "stopped" and v.get("turn") is None, (v["state"], v.get("turn")))
finally:
    srv.terminate()
    try:
        srv.wait(8)
    except Exception:
        srv.kill()
print("\nRESULT:", "ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
