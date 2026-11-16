#!/usr/bin/env python3
"""Clock module (web/clock.js + server `clock` setting + face.js hooks). Silent: headless Chrome with --mute-audio against a
spare-port testsrv (never the live kiosk), no model, no speakers.

  RETRO_MAC_PORT=8795 python tests/testsrv.py server.py 8795 &
  python tests/test_clock.py [port]          (default 8795; needs websockets from the venv)

Server: `clock` setting accepts off|flip|cuckoo|screensaver|morph, rejects junk, is broadcast + replayed on connect, loads from settings.json.
Browser: default look unchanged (pixel diff vs the page with clock.js blocked, outside the tag + face), every variant stays inside its
corner for hours of simulated drift and moves <= 1 px per 5 s, inverts on schedule, flip/morph animate on the minute and settle, cuckoo
announces on the hour (n pops, crew rotation, silent hours), the face glance hook is called, screensaver takes over after the quiet time /
in night rest and wakes at once (key, crew work), key C + tag click cycle and persist, AOL skin hides everything, windows hide it.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from clockdrive import Chrome  # noqa: E402
from websockets.sync.client import connect  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8795
BASE = f"http://127.0.0.1:{PORT}"
FAILS = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""), flush=True)
    if not cond:
        FAILS.append(name)


def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=5)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def ws_settings():
    """what a freshly connected display is told"""
    ws = connect(f"ws://127.0.0.1:{PORT}/ws", open_timeout=5)
    try:
        for _ in range(12):
            m = json.loads(ws.recv(timeout=5))
            if m.get("type") == "settings":
                return m
    finally:
        ws.close()
    return {}


def wait_for(fn, secs, step=0.1):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(step)
    return None


# ---------------------------------------------------------------- server part
post("/event", {"clock": "off"})
check("default / reset: clock off", ws_settings().get("clock") == "off", ws_settings())
for v in ("flip", "cuckoo", "screensaver", "morph", "off"):
    st, r = post("/event", {"clock": v})
    check(f"POST clock={v} accepted + broadcast to a new display", st == 200 and r.get("clock") == v and ws_settings().get("clock") == v, (st, r))
post("/event", {"clock": "flip"})
for bad in ("bogus", 3, None, ["flip"], {"a": 1}, True, ""):
    st, r = post("/event", {"clock": bad})
    check(f"clock={bad!r} rejected, setting unchanged", st == 200 and ws_settings().get("clock") == "flip", (st, r))
st, r = post("/event", {"clock": "morph", "theme": "amber"})
check("clock alongside other keys applies both", r.get("clock") == "morph" and r.get("theme") == "amber", r)
post("/event", {"theme": "green", "clock": "off"})

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
try:                                                    # settings.json loading (in-process, never touches the real settings file)
    import importlib.util
    import tempfile
    spec = importlib.util.spec_from_file_location("server_under_test2", Path(__file__).resolve().parents[1] / "server" / "server.py")
    srv = importlib.util.module_from_spec(spec); sys.modules["server_under_test2"] = srv; spec.loader.exec_module(srv)
    tmp = Path(tempfile.mkdtemp(prefix="clock-settings-")) / "settings.json"
    srv.SETTINGS_FILE = tmp
    tmp.write_text(json.dumps({"clock": "cuckoo", "theme": "amber"})); srv.settings["clock"] = "off"; srv.load_settings()
    check("settings.json clock loads", srv.settings["clock"] == "cuckoo", srv.settings)
    tmp.write_text(json.dumps({"clock": "nonsense"})); srv.settings["clock"] = "off"; srv.load_settings()
    check("settings.json junk clock ignored", srv.settings["clock"] == "off", srv.settings)
    check("CLOCKS order matches the client", list(srv.CLOCKS) == ["off", "flip", "cuckoo", "screensaver", "morph"], srv.CLOCKS)
except Exception as e:                                  # pragma: no cover
    check("settings.json loading test ran", False, repr(e))

# ---------------------------------------------------------------- browser part
ZONE = dict(x0=4, y0=14, x1=212, y1=118)                # top-left corner above the face: weather starts at x 214, the face at y ~122, menu bar ends y 14
Q = "/?test&noburn&hour=14&agent=alfred&"
with Chrome(PORT) as P:
    st = lambda: P.clock()  # noqa: E731

    # ---- default look unchanged: identical to a page where clock.js never loaded (outside the tag and the face)
    def canvas_bits():
        return P.js("(() => { const d = document.getElementById('c').getContext('2d').getImageData(0, 0, 512, 342).data; let s = ''; "
                    "for (let i = 1; i < d.length; i += 4) s += d[i] > 100 ? '1' : '0'; return s; })()")

    best = 1.0
    for _ in range(4):
        P.call("Network.enable"); P.call("Network.setBlockedURLs", urls=["*clock.js*"])
        P.open(Q + "mood=neutral", settle=3.5); has = P.js("typeof window.RetroClock")
        a = canvas_bits()
        P.call("Network.setBlockedURLs", urls=[])
        P.open(Q + "mood=neutral", settle=3.5)
        b = canvas_bits()
        diff = 0
        for y in range(342):
            for x in range(512):
                if (428 <= x < 470 and y < 20) or (x < 215 and 112 <= y < 235):   # the CLK tag; the face (blinks / glances differ per run)
                    continue
                if a[y * 512 + x] != b[y * 512 + x]:
                    diff += 1
        best = min(best, diff / (512 * 342))
        if best == 0:
            break
    check("clock.js blocked -> page still runs (RetroClock undefined)", has == "undefined", has)
    check("default (off) look identical to a page without clock.js, outside the CLK tag + face", best < 0.0005, f"{best:.5f}")
    P.open(Q + "mood=neutral", settle=3)
    s0 = st()
    check("default variant is off, nothing drawn but the tag", s0["variant"] == "off" and s0["drawn"] is None and s0["tag"], s0)

    # ---- pure placement: stays in the corner for 3 hours of drift, <= 1 px per 5 s, really moves
    P.open(Q + "clock=off", settle=2)
    walk = json.loads(P.js("""JSON.stringify(['flip','cuckoo','morph','screensaver'].map(v => { const base = Date.parse('2026-11-16T05:00:00Z'); let prev = null, maxStep = 0, seen = new Set(), bad = [];
      for (let ms = base; ms < base + 3 * 3600e3; ms += v === 'screensaver' ? 600 : 5000) { const p = RetroClock.place(v, ms); seen.add(p.x + ',' + p.y);
        if (v !== 'screensaver' && (p.x < 4 || p.y < 14 || p.x + p.w > 212 || p.y + p.h > 118)) bad.push([p.x, p.y, p.w, p.h]);
        if (v === 'screensaver' && (p.x < 0 || p.y < 0 || p.x + p.w > 512 || p.y + p.h > 342)) bad.push([p.x, p.y, p.w, p.h]);
        if (prev) maxStep = Math.max(maxStep, Math.abs(p.x - prev.x), Math.abs(p.y - prev.y)); prev = p; }
      return { v, positions: seen.size, maxStep, bad: bad.slice(0, 3) }; }))"""))
    for w in walk:
        corner = w["v"] != "screensaver"
        check(f"{w['v']}: stays inside {'its corner' if corner else 'the canvas'} over 3 h of drift", not w["bad"], w["bad"])
        check(f"{w['v']}: drifts ({w['positions']} positions in 3 h) a pixel at a time (max step {w['maxStep']})", w["positions"] >= 8 and w["maxStep"] <= 1, w)

    # ---- every overlay variant actually draws in the corner (lit pixels vs off) and the tag reflects it
    def lit(x0, y0, x1, y1):
        return P.js("(() => { const d = document.getElementById('c').getContext('2d').getImageData(%d, %d, %d, %d).data; let n = 0; for (let i = 1; i < d.length; i += 4) if (d[i] > 100) n++; return n; })()" % (x0, y0, x1 - x0, y1 - y0))

    P.open(Q + "clock=off", settle=2.5); base_lit = lit(0, 18, 212, 118); seam_base = lit(211, 18, 214, 118)
    for v in ("flip", "cuckoo", "morph"):
        P.open(Q + f"clock={v}&clocktime=14:47:20", settle=2.5)
        s = st()
        n = lit(0, 18, 212, 118)
        check(f"{v}: draws in the corner ({n} lit px vs {base_lit} off) and reports its rect", n > base_lit + 300 and s["drawn"] and s["drawn"]["kind"] == v, (n, base_lit, s["drawn"]))
        check(f"{v}: shows 2:47 PM digits", s["clock"]["digits"] == ["", "2", "4", "7"], s["clock"])

    # ---- flip / morph animate on the minute, then settle
    for v, dur in (("flip", 2.0), ("morph", 3.0)):
        P.open(Q + f"clock={v}&clocktime=14:59:57", settle=2.0)
        check(f"{v}: idle before the minute -> not animating", not st()["drawn"]["anim"])
        went = wait_for(lambda: st()["drawn"]["anim"], 5, 0.03)
        check(f"{v}: animates when 2:59 -> 3:00", went is not None)
        time.sleep(dur)
        s = st()
        check(f"{v}: settles on 3:00 after the animation", s["drawn"]["anim"] is False and s["clock"]["digits"] == ["", "3", "0", "0"], s)

    # ---- invert (burn-in) on schedule: ?clockinv=6 -> flips every 6 s of wall clock; flip animates it
    P.open(Q + "clock=flip&clocktime=14:00:00&clockinv=6", settle=2.0)
    seen = set(); anim_on_inv = False
    t0 = time.time()
    while time.time() - t0 < 14:
        d = st()["drawn"]; seen.add(d["inv"]); anim_on_inv = anim_on_inv or d["anim"]
        time.sleep(0.1)
    check("flip: inverts on schedule (both ink/paper states seen in 14 s at clockinv=6)", seen == {True, False}, seen)
    check("flip: the invert is shown as a card flip", anim_on_inv)
    P.open(Q + "clock=off", settle=1.5)
    check("invert is wall-clock aligned (10 min periods)", P.js("RetroClock.invAt(0) === false && RetroClock.invAt(600000) === true && RetroClock.invAt(1200000) === false"))

    # ---- cuckoo: hourly announcement
    P.open(Q + "clock=cuckoo&clocktime=14:59:53", settle=1.5)
    check("cuckoo: quiet before the hour", st()["ann"] is None)
    ann = wait_for(lambda: st()["ann"], 8, 0.05)
    check("cuckoo: announces at 3:00 PM", ann is not None and ann["n"] == 3 and ann["agent"] in ("alfred", "scout", "maker"), ann)
    check("cuckoo: 3 PM is announced by Alfred (crew rotation hour % 3)", ann and ann["agent"] == "alfred", ann)
    check("cuckoo: animating + glancing while it announces", st()["drawn"]["anim"] and st()["glance"])
    seam = []                                            # the bubble must never touch the weather panel (x >= 214): watch the 3 px seam all announcement long
    t0 = time.time()
    while time.time() - t0 < 4.5 and st()["ann"]:
        seam.append(lit(211, 18, 214, 118)); time.sleep(0.12)
    check("cuckoo: speech bubble never reaches the weather panel (x < 214)", seam and max(seam) <= seam_base, (max(seam or [0]), seam_base))
    check("cuckoo: announcement ends and settles", wait_for(lambda: st()["ann"] is None and not st()["drawn"]["anim"], 9, 0.2) is not None, st())
    P.open(Q + "clock=cuckoo&clocktime=15:59:58", settle=1.8)
    ann = wait_for(lambda: st()["ann"], 6, 0.05)
    check("cuckoo: 4 PM -> Scout, 4 pops", ann and ann["agent"] == "scout" and ann["n"] == 4, ann)
    P.open(Q + "clock=cuckoo&clocktime=11:59:58", settle=1.8)
    ann = wait_for(lambda: st()["ann"], 6, 0.05)
    check("cuckoo: noon -> 12 pops, Alfred (12 % 3 = 0)", ann and ann["n"] == 12 and ann["agent"] == "alfred", ann)
    for t in ("21:59:58", "23:59:58", "5:59:58", "22:59:58"):
        P.open(Q + f"clock=cuckoo&clocktime={t}", settle=1.8)
        time.sleep(3.2)
        check(f"cuckoo: silent in quiet hours ({t} -> next hour)", st()["ann"] is None)
    P.open(Q + "clock=cuckoo&clocktime=6:59:58", settle=1.8)
    check("cuckoo: 7 AM is the first announcement of the day", wait_for(lambda: st()["ann"], 6, 0.05) is not None)
    P.open(Q + "clock=cuckoo&clocktime=14:47:20&clockcuckoo=1", settle=1.2)
    check("cuckoo: ?clockcuckoo test trigger works (any hour)", wait_for(lambda: st()["ann"], 4, 0.1) is not None)
    P.open(Q + "clock=flip&clocktime=14:59:58", settle=1.8); time.sleep(3)
    check("flip/other variants never announce", st()["ann"] is None)

    # ---- the face glance hook: face.js asks RetroClock.gaze while idle and applies it
    P.open(Q + "clock=cuckoo&clocktime=14:47:20&clockglance&mood=neutral", settle=1.0)
    P.js("window.__g = 0; const g = RetroClock.gaze; RetroClock.gaze = (t) => { window.__g++; return g(t); }; 0")
    time.sleep(1.5)
    check("face.js calls RetroClock.gaze every frame while idle", P.js("window.__g") > 3, P.js("window.__g"))
    check("cuckoo glances (state.glance goes true)", wait_for(lambda: st()["glance"], 6, 0.05) is not None)
    P.open(Q + "clock=off", settle=1.0)
    P.js("window.__g = 0; if (window.RetroClock) { const g = RetroClock.gaze; RetroClock.gaze = (t) => { window.__g++; return g(t); }; } 0")
    time.sleep(1.0)
    check("no glance when the clock is off", P.js("RetroClock.gaze(performance.now())") is None)

    # ---- screensaver
    P.open(Q + "clock=screensaver&clocktime=14:47:20&clockidle=1.5", settle=1.2)
    check("saver: dashboard first (not idle long enough)", not st()["saver"])
    check("saver: takes over after the quiet time", wait_for(lambda: st()["saver"], 5, 0.1) is not None)
    time.sleep(1.8)
    rect = st()["drawn"]["rect"]
    check("saver: digits box inside the canvas", rect["px"] >= 0 and rect["py"] >= 0 and rect["px"] + rect["bw"] <= 512 and rect["py"] + rect["bh"] <= 342, rect)
    n_dash = lit(0, 0, 512, 342)
    check("saver: the dashboard is gone (far fewer lit pixels than the dashboard)", n_dash < 14000, n_dash)
    P.key("a", "KeyA"); time.sleep(0.45)
    check("saver: a key wakes it instantly", not st()["saver"], st())
    check("saver: ... and it comes back after the quiet time", wait_for(lambda: st()["saver"], 5, 0.1) is not None)
    P.mouse(300, 300); P.mouse(330, 320); time.sleep(0.45)
    check("saver: mouse wakes it", not st()["saver"], st())
    wait_for(lambda: st()["saver"], 5, 0.1)
    post("/activity", {"agent": "maker", "status": "working", "label": "CODING"}); time.sleep(0.8)
    check("saver: crew activity wakes it", not st()["saver"], st())
    time.sleep(2.5)
    check("saver: stays away while the crew works", not st()["saver"], st())
    post("/activity", {"agent": "maker", "status": "idle", "label": ""})
    check("saver: returns once the crew is idle", wait_for(lambda: st()["saver"], 8, 0.2) is not None)
    P.open(Q + "clock=screensaver&clocktime=14:47:20&clockidle=99999", settle=2.5)
    check("saver: not by day while the quiet time has not passed", not st()["saver"])
    P.open("/?test&hour=2&clocktime=2:47:20&agent=alfred&restidle=1&dimidle=1&clock=screensaver&clockidle=99999", settle=4)
    bs = json.loads(P.js("JSON.stringify(RetroBurn.state())"))
    check("saver: runs automatically inside night rest (burnin.js mode rest)", bs["mode"] == "rest" and st()["saver"], (bs, st()))
    P.open("/?test&hour=2&clocktime=2:47:20&agent=alfred&restidle=1&dimidle=1&clock=flip&clockidle=1", settle=4)
    check("other variants never take the screen, even in night rest", not st()["saver"] and json.loads(P.js("JSON.stringify(RetroBurn.state())"))["mode"] == "rest")

    # ---- switcher: key C cycles + persists through the server, tag click too, ?clock= pages stay local
    post("/event", {"clock": "off"})
    P.open(Q.replace("&noburn", "") + "mood=neutral", settle=2.5)
    order, toast, demo = [], None, None
    for i in range(5):
        P.key("c", "KeyC"); time.sleep(0.5)
        order.append((st()["variant"], ws_settings().get("clock")))
        if i == 0: toast = st()["toast"]
        if i == 2: demo = (st()["demo"], st()["saver"])
    check("key C cycles off -> flip -> cuckoo -> screensaver -> morph -> off, each persisted by the server",
          [o[0] for o in order] == ["flip", "cuckoo", "screensaver", "morph", "off"] and all(a == b for a, b in order), order)
    check("a toast names the new variant", toast == "CLOCK: FLIP", toast)
    check("switching to the screensaver with C plays the demo straight away", demo == (True, True), demo)
    post("/event", {"clock": "off"}); time.sleep(0.5)
    P.click_canvas(449, 9); time.sleep(0.6)
    check("clicking the tiny CLK tag cycles too (off -> flip) and persists", st()["variant"] == "flip" and ws_settings().get("clock") == "flip", (st()["variant"], ws_settings()))
    P.open(Q.replace("&noburn", "") + "mood=neutral", settle=2.5)
    check("a fresh page picks the persisted variant up from the server", st()["variant"] == "flip" and st()["drawn"] is not None, st())
    post("/event", {"clock": "cuckoo"}); time.sleep(0.6)
    check("a live page follows a server change (POST /event clock)", st()["variant"] == "cuckoo", st()["variant"])
    P.open(Q.replace("&noburn", "") + "clock=morph&mood=neutral", settle=2.0)
    P.key("c", "KeyC"); time.sleep(0.5)
    check("?clock= preview page: key C changes it locally and does NOT touch the server", st()["variant"] == "off" and ws_settings().get("clock") == "cuckoo", (st()["variant"], ws_settings()))
    post("/event", {"clock": "off"})
    P.open(Q + "mood=neutral", settle=2.5)
    P.js("RetroClock.set('screensaver')"); time.sleep(0.6)
    s = st()
    check("selecting the screensaver starts the demo (saver on, demo flag)", s["demo"] and s["saver"], s)
    time.sleep(1.2); P.key("a", "KeyA"); time.sleep(0.4)
    check("... any key after the first instant ends the demo", not st()["demo"] and not st()["saver"], st())
    post("/event", {"clock": "off"})

    # ---- AOL skin keeps its own clock: nothing of ours is drawn, key C does nothing there
    P.open(Q + "clock=flip&theme=aol", settle=3.0)
    s = st()
    check("AOL skin: no clock overlay, no tag", s["drawn"] is None and s["tag"] is None, s)
    P.key("c", "KeyC"); time.sleep(0.4)
    check("AOL skin: key C is ignored", st()["variant"] == "flip")

    # ---- windows / zooms own the screen: overlay hides and returns
    P.open(Q + "clock=flip&clocktime=14:47:20", settle=2.5)
    check("flip visible on the plain dashboard", st()["drawn"] is not None)
    P.key("1", "Digit1"); time.sleep(1.0)
    check("a click-in window (key 1) hides the clock", st()["drawn"] is None)
    P.key("Escape", "Escape"); time.sleep(1.0)
    check("... and Esc brings it back", st()["drawn"] is not None)
    P.click_canvas(300, 80); time.sleep(1.2)
    check("a panel zoom (click WEATHER) hides the clock", st()["drawn"] is None)
    P.key("Escape", "Escape"); time.sleep(1.0)

    # ---- menu bar on: the tag moves into the bar, the clock stays below it
    P.open(Q + "clock=flip&clocktime=14:47:20&menubar", settle=2.5)
    s = st()
    check("menu bar on: tag sits inside the bar (y < 14), clock below it (y >= 18)", s["tag"] and s["tag"]["y"] == 0 and s["drawn"]["y"] >= 18, s)

    # ---- night look: face asleep + clock still ok at hour 2 (no crash); wipe mode on top
    P.open("/?test&hour=2&clocktime=2:47:20&agent=alfred&noburn&clock=flip&idle=200", settle=3)
    check("night (face asleep): flip still draws", st()["drawn"] is not None)


if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("\nall clock checks passed")
