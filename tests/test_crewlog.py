#!/usr/bin/env python3
"""Fable: crew journal (crewlog.py) + LOG/menubar server plumbing. Silent, stdlib only, never touches :8787.

  python tests/test_crewlog.py [port]        (default 8798)

Part 1 = pure unit tests of crewlog.CrewLog with an injected clock in a temp dir (dedupe, day roll, reload after
"restart", counts, unread, prune, text cleaning). Part 2 starts its own testsrv on the spare port and checks
GET /log after /activity transitions, /health uptime + journal counter, POST /event {menubar} round trip and that
the web files parse (node --check) and index.html loads lipsync.js.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from crewlog import CrewLog, clean  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
assert PORT != 8787, "never the live kiosk port"
BASE = f"http://127.0.0.1:{PORT}"
fails = 0


def check(name, got, want=True):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


# ------------------------------------------------------------------ part 1: pure
tmp = Path(tempfile.mkdtemp(prefix="crewlog-", dir=os.environ.get("TMPDIR")))
T = {"now": 1_800_000_000.0}          # fake clock (2027-01-15 in any TZ)
clk = lambda: T["now"]
log = CrewLog(tmp, now=clk)
check("empty day", log.today()["entries"], [])
e = log.add("done", "maker", "CODING face.js", took=42.7)
check("entry shape", {k: e[k] for k in ("kind", "agent", "text", "took")}, {"kind": "done", "agent": "maker", "text": "CODING face.js", "took": 42})
check("duplicate within 60 s collapses", log.add("done", "maker", "CODING face.js", took=3), None)
check("collapsed count kept in memory", log.today()["entries"][0].get("n"), 2)
T["now"] += 61
check("same label after 60 s is a new entry", bool(log.add("done", "maker", "CODING face.js")), True)
check("bad kind dropped", log.add("nope", "maker", "x"), None)
check("empty text dropped", log.add("reply", "alfred", "   "), None)
check("unknown agent -> alfred", log.add("reply", "hal", "Hello there.")["agent"], "alfred")
check("text cleaned + clipped", len(clean("x" * 200)), 90)
check("control chars stripped", clean("a\x00b<script>"), "abscript")
log.add("failed", "alfred", "LIMIT HIT TRY AGAIN AT 11:10 PM", note="limit")
log.add("asked", "alfred", "what's the weather")
c = log.counts()
check("counts per agent", (c["maker"]["done"], c["alfred"]["reply"], c["alfred"]["failed"], c["alfred"]["asked"]), (2, 1, 1, 1))
check("unread since", log.unread(T["now"] - 1), 4)          # everything added after the +61 s jump
check("today(since) filters", len(log.today(T["now"] - 1)["entries"]), 4)
check("file written", log.path_for(log.day).exists(), True)
lines = log.path_for(log.day).read_text().splitlines()
check("one json line per stored entry (dupes not re-written)", len(lines), 5)
# "restart": a new instance over the same dir sees the same entries
log2 = CrewLog(tmp, now=clk)
check("survives restart", [x["text"] for x in log2.today()["entries"]], [x["text"] for x in log.today()["entries"]])
check("seq restored", log2.seq, 5)
# day roll: next local day starts a fresh file, old one untouched
old_day, old_path = log.day, log.path_for(log.day)
T["now"] += 86400
check("new day rolls", log.today()["day"] != old_day and log.today()["entries"] == [], True)
log.add("reply", "scout", "New day.")
check("old file untouched", len(old_path.read_text().splitlines()), 5)
# prune: files older than keep_days go, today's stays
for d in ("2001-01-01", "2010-05-05"):
    (tmp / f"crew-log-{d}.jsonl").write_text("{}\n")
check("prune removes old files", log.prune(30), 2)        # the two fakes go; yesterday's and today's stay
check("prune keeps recent", old_path.exists(), True)
# corrupt line is skipped on load
with open(log.path_for(log.day), "a") as f:
    f.write("not json\n")
check("corrupt line ignored", len(CrewLog(tmp, now=clk).today()["entries"]), 1)
shutil.rmtree(tmp, ignore_errors=True)

# ------------------------------------------------------------------ part 2: server
def req(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data, {"Content-Type": "application/json"}, method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


env = dict(os.environ, RETRO_MAC_PORT=str(PORT))
srv = subprocess.Popen([sys.executable, str(ROOT / "tests" / "testsrv.py"), str(ROOT / "server" / "server.py"), str(PORT)],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(120):
        try:
            if req("/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    else:
        raise SystemExit("test server did not come up")
    st, h = req("/health")
    check("/health has uptime + journal", st == 200 and isinstance(h.get("uptime"), (int, float)) and isinstance(h.get("journal"), int), True)
    st, j0 = req("/log")
    check("/log ok", st == 200 and j0.get("ok") and "entries" in j0 and "counts" in j0, True)
    n0 = len(j0["entries"])
    tag = f"FABLE TEST {int(time.time()) % 100000}"
    req("/activity", {"agent": "maker", "status": "working", "label": tag})
    time.sleep(0.3)
    req("/activity", {"agent": "maker", "status": "idle"})
    time.sleep(0.3)
    st, j1 = req("/log")
    new = [e for e in j1["entries"] if e["text"] == tag[:28].upper()]
    check("finished job journaled as done", len(new) == 1 and new[0]["kind"] == "done" and new[0]["agent"] == "maker", True)
    check("counts moved", j1["counts"]["maker"]["done"] >= j0["counts"]["maker"]["done"] + 1, True)
    st, js = req(f"/log?since={new[0]['at'] - 0.05}") if new else (0, {})
    check("?since filters", bool(st == 200 and js["entries"] and all(e["at"] > new[0]["at"] - 0.05 for e in js["entries"])), True)
    check("THINKING alone is not a job", not any(e["text"] == "THINKING" for e in j1["entries"]), True)
    st, ev = req("/event", {"menubar": True})
    check("menubar setting accepted", st == 200 and ev.get("menubar") is True, True)
    st, ev = req("/event", {"menubar": "yes"})
    check("menubar needs a bool", ev.get("menubar") in (None, True, False) and ev.get("menubar") != "yes", True)
    req("/event", {"menubar": False})
    st, ev = req("/log?since=notanumber")
    check("bad since tolerated", st, 200)
    # static files
    for f in ("face.js", "windows.js", "lipsync.js", "panels.js", "banner.js", "aol.js"):
        r = subprocess.run(["node", "--check", str(ROOT / "web" / f)], capture_output=True, text=True)
        check(f"node --check {f}", r.returncode == 0, True)
    check("index.html loads lipsync.js", "lipsync.js" in (ROOT / "web/index.html").read_text(), True)
    src = (ROOT / "server" / "server.py").read_text() + (ROOT / "server" / "crewlog.py").read_text()
    check("server imports no Hermes code", not any(s in src for s in ("import hermes", "from hermes", "hermes_constants", "from agent")), True)
    w = (ROOT / "web/windows.js").read_text()
    check("LOG + ABOUT bodies registered", "log: drawLog" in w and "about: drawAbout" in w, True)
finally:
    srv.terminate()
    try:
        srv.wait(5)
    except Exception:
        srv.kill()

print("\nFAILS:", fails)
sys.exit(1 if fails else 0)
