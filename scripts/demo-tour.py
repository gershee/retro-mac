#!/usr/bin/env python3
"""Scripted demo of one full voice turn, driven through the real HTTP endpoints (no Hermes, no microphone):

  HEARD -> LISTENING (mic meter) -> GOT IT -> WORKING (step checklist) -> Alfred answers with a card,
  then Scout and Maker chime in.

  ./start.sh --demo && python3 scripts/demo-tour.py          (open http://127.0.0.1:8787/ first)
  RETRO_MAC_PORT=8797 python3 scripts/demo-tour.py --short   just the voice turn
"""
import json
import math
import os
import sys
import time
import urllib.request

BASE = os.environ.get("RETRO_MAC_BASE", "http://127.0.0.1:%s" % os.environ.get("RETRO_MAC_PORT", "8787"))
SID = "demo-%d" % int(time.time())


def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")
    except Exception as e:  # keep the tour going
        return {"error": str(e)}


def step(caption, cid, secs):
    post("/activity", {"agent": "alfred", "status": "working", "label": caption[:28], "session_id": SID,
                       "caption": caption, "step": "start", "call_id": cid})
    time.sleep(secs)
    post("/activity", {"agent": "alfred", "status": "thinking", "label": "THINKING", "session_id": SID,
                       "step": "done", "call_id": cid})


def main():
    short = "--short" in sys.argv
    post("/voice_state", {"state": "heard", "window": 8})
    time.sleep(1.2)
    post("/voice_state", {"state": "listening", "window": 8})
    t0 = time.time()
    while time.time() - t0 < 2.6:                       # fake mic meter: someone talking
        k = time.time() - t0
        post("/level", {"l": 0.35 + 0.3 * abs(math.sin(k * 7)), "s": k, "sp": True})
        time.sleep(0.12)
    post("/voice_state", {"state": "transcribing"})
    time.sleep(0.9)
    post("/voice_turn", {"agent": "alfred", "session_id": SID, "platform": "tui", "marker": True,
                         "text": "What does my afternoon look like?"})
    time.sleep(1.0)
    step("CHECKING YOUR CALENDAR", "c1", 1.6)
    step("CHECKING THE WEATHER", "c2", 1.4)
    post("/speak", {"agent": "alfred", "voice": "voice", "session_id": SID, "text":
                    "[happy] You're free until three. Then school pickup, and rain moves in around four, "
                    "so grab an umbrella.\n- 3:15 School pickup\n- 4:00 1:1 with Robin\n- 6:30 Climbing gym"})
    if short:
        return
    time.sleep(11)
    post("/speak", {"agent": "scout", "force": True,
                    "text": "[curious] Scout here. I found three new leads overnight. One of them looks promising."})
    time.sleep(7)
    post("/speak", {"agent": "maker", "force": True,
                    "text": "[happy] Maker reporting. The build is green and the update is ready to ship."})


if __name__ == "__main__":
    main()
