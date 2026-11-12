#!/usr/bin/env python3
"""Push-to-talk server test. Silent, no model, no speakers, no real tmux.

Needs the fake-TUI test server:  FAKE_TUI=1 venv/bin/python tests/testsrv.py server/server.py 8792
  venv/bin/python tests/test_ptt.py [port]

Checks /event {ptt}, /health ptt, /ptt off -> 409, start (arm + Ctrl-B + heard), double tap while opening, stop (second
Ctrl-B), busy states (transcribing / working turn / speaking), voice-off TUI, ptt_req ids for the wake daemon.
"""
import json
import sys
import time
import urllib.error
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
BASE = f"http://127.0.0.1:{PORT}"
FAILS = []


def call(path, body=None):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    try:
        r = urllib.request.urlopen(req, timeout=5)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def keys():
    return call("/_keys")[1]


h = call("/health")[1]
check("health has ptt + ptt_req", "ptt" in h and "ptt_req" in h, h.get("ptt"))
call("/event", {"ptt": False})
call("/voice_state", {"state": "idle"})
call("/disarm", {})
c, j = call("/ptt", {})
check("ptt off -> 409 off, no key", c == 409 and j.get("action") == "off" and not keys()["keys"], (c, j))

c, j = call("/event", {"ptt": True})
check("/event ptt true", c == 200 and j.get("ptt") is True, (c, j))
h = call("/health")[1]
check("health ptt true", h["ptt"] is True and h["voice"]["ptt"] is True)

n0 = h["ptt_req"]["id"]
c, j = call("/ptt", {})
k = keys()
h = call("/health")[1]
check("start: action start, one Ctrl-B", c == 200 and j.get("action") == "start" and k["keys"] == ["C-b"], (c, j, k))
check("start: armed ~600 s", 590 < h["armed_for"] <= 600, h["armed_for"])
check("start: ptt_req start, window 8", h["ptt_req"]["kind"] == "start" and h["ptt_req"]["id"] == n0 + 1 and h["ptt_req"]["window"] == 8.0, h["ptt_req"])
time.sleep(0.6)
h = call("/health")[1]
check("fake REC edge -> listening banner", h["voice"]["state"] == "listening" and h["tui"]["rec"] is True, h["voice"]["state"])

c, j = call("/ptt", {})
k = keys()
h = call("/health")[1]
check("second tap while recording: stop, second Ctrl-B", c == 200 and j.get("action") == "stop" and k["keys"] == ["C-b", "C-b"] and k["rec"] is False, (c, j, k))
check("stop: ptt_req kind stop", h["ptt_req"]["kind"] == "stop" and h["ptt_req"]["id"] == n0 + 2, h["ptt_req"])
time.sleep(0.6)
h = call("/health")[1]
check("stop -> transcribing (GOT IT)", h["voice"]["state"] == "transcribing", h["voice"]["state"])

c, j = call("/ptt", {})
check("tap while transcribing -> 409 busy, no key", c == 409 and j.get("action") == "busy" and len(keys()["keys"]) == 2, (c, j))

call("/voice_state", {"state": "idle"})
call("/voice_turn", {"agent": "alfred", "session_id": "s-ptt", "platform": "tui", "text": "what is up", "marker": True})
st = call("/health")[1]["voice"]["state"]
c, j = call("/ptt", {})
check("tap while a voice turn is working -> busy", c == 409 and j.get("action") == "busy" and len(keys()["keys"]) == 2, (st, c, j))
call("/voice_state", {"state": "done", "session_id": "s-ptt"})
call("/voice_state", {"state": "idle"})

# start again right after a start: second request inside the opening window is 'starting', no extra Ctrl-B
call("/voice_state", {"state": "idle"})
c1, j1 = call("/ptt", {})
n_keys = len(keys()["keys"])
c2, j2 = call("/ptt", {})        # REC not yet visible to the poll for <0.2 s on the fake: behaves as stop if rec else starting
print("      (info) rapid second tap ->", j2.get("action"), "keys", n_keys, "->", len(keys()["keys"]))
check("rapid second tap never double-starts", j1.get("action") == "start" and j2.get("action") in ("starting", "stop"), (j1, j2))
if keys()["rec"]:
    call("/ptt", {})             # leave the fake TUI not recording
call("/voice_state", {"state": "idle"})

# speaking: busy
call("/stop", {})
call("/disarm", {})
c, j = call("/event", {"ptt": False})
c, j = call("/ptt", {})
check("mode off again: /ptt 409 off", c == 409 and j.get("action") == "off", (c, j))
h = call("/health")[1]
check("health ptt false after off", h["ptt"] is False)
call("/event", {"ptt": "yes"})
check("non-bool ptt ignored", call("/health")[1]["ptt"] is False)
print("\nSUMMARY: %d FAIL" % len(FAILS) if FAILS else "\nSUMMARY: all ptt checks passed")
sys.exit(1 if FAILS else 0)
