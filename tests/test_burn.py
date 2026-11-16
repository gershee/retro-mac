#!/usr/bin/env python3
"""Anti burn-in layer (web/burnin.js + POST /event {"wipe": minutes}). Silent: headless Chrome with --mute-audio against a
spare-port testsrv (never the live kiosk), no model, no speakers.

  RETRO_MAC_PORT=8796 python tests/testsrv.py server.py 8796 &
  python tests/test_burn.py [port]          (default 8796; needs websockets from the venv)

Server: wipe minutes / true / 0 / bad input, /health wipe_for, wipe state replayed to a new display.
Browser: pixel orbit stays inside the viewport at whole device pixels and really moves; the layer changes nothing in the daytime
look (screenshot diff vs ?noburn with the orbit parked); night rest / day dim thresholds + instant wake (key, mouse, crew
activity); clearing mode via ?wipe, key W, Esc, POST /event, auto end, every sampled pixel swings dark<->light, and no pixel flips
faster than 3x/s.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8796
BASE = f"http://127.0.0.1:{PORT}"
CDP = 9447
CHROME = os.environ.get("RETRO_MAC_CHROME") or next((p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or "") if p and os.path.exists(p)), "")
FAILS = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=5)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def health():
    return json.loads(urllib.request.urlopen(BASE + "/health", timeout=5).read())


class Page:
    def __init__(self, ws_url):
        self.ws = connect(ws_url, max_size=64 * 1024 * 1024, open_timeout=10)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv(timeout=30))
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})

    def js(self, expr, wait=False):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=wait)
        if "exceptionDetails" in r:
            raise RuntimeError(str(r["exceptionDetails"])[:300])
        return r["result"].get("value")

    def open(self, path, w=1440, h=900, dpr=2, settle=2.0):
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=dpr, mobile=False)
        self.call("Page.navigate", url=BASE + path)
        time.sleep(settle)

    def key(self, key, code):
        for t in ("keyDown", "keyUp"):
            self.call("Input.dispatchKeyEvent", type=t, key=key, code=code, text=key if t == "keyDown" and len(key) == 1 else "")

    def mouse(self, x, y):
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)

    def shot(self):
        return self.call("Page.captureScreenshot", format="png")["data"]

    def state(self):
        return json.loads(self.js("JSON.stringify(RetroBurn.state())"))


def wait_for(fn, secs, step=0.2):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = fn()
        except (OSError, urllib.error.URLError):
            v = None
        if v:
            return v
        time.sleep(step)
    return None


# ---------------------------------------------------------------- server part
st, r = post("/event", {"wipe": 5})
check("wipe 5 min accepted", st == 200 and abs(r.get("left", 0) - 300) < 2 and r.get("total") == 300, r)
check("health wipe_for", 290 < health().get("wipe_for", 0) <= 300, health().get("wipe_for"))
st, r = post("/event", {"wipe": 0})
check("wipe 0 stops", st == 200 and r.get("left") == 0 and health().get("wipe_for") == 0, r)
st, r = post("/event", {"wipe": True})
check("wipe true = 20 min", st == 200 and abs(r.get("left", 0) - 1200) < 2, r)
post("/event", {"wipe": False})
check("wipe false stops", health().get("wipe_for") == 0)
st, r = post("/event", {"wipe": 9999})
check("wipe capped at 240 min", st == 200 and r.get("total") == 14400, r)
post("/event", {"wipe": 0})
st, r = post("/event", {"wipe": "soon"})
check("wipe junk rejected", st == 400 and not r.get("ok"), r)
st, r = post("/event", {"theme": "amber", "wipe": 0})
check("wipe alongside other keys still applies them", st == 200 and r.get("theme") == "amber", r)
post("/event", {"theme": "green"})

# ---------------------------------------------------------------- browser part
tmp = tempfile.mkdtemp(prefix="burn-chrome-", dir=os.environ.get("TMPDIR") or None)
chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={CDP}", f"--user-data-dir={tmp}", "--mute-audio",
                           "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900", "about:blank"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    tabs = wait_for(lambda: (lambda: json.loads(urllib.request.urlopen(f"http://127.0.0.1:{CDP}/json/list", timeout=2).read()))(), 15)
    tab = next(t for t in tabs if t.get("type") == "page")
    P = Page(tab["webSocketDebuggerUrl"])
    P.call("Page.enable")

    # ---- orbit: stays inside the viewport, whole device pixels, really moves, art stays crisp
    P.open("/?hour=12&orbit=0.6", settle=3)
    seen, bad = set(), []
    for _ in range(60):
        s = P.js("""JSON.stringify((() => { const r = document.getElementById('screen').getBoundingClientRect(), c = document.getElementById('c').getBoundingClientRect(),
          b = RetroBurn.state(); return {ox: b.ox, oy: b.oy, dpr: b.dpr, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cl: c.left, ct: c.top, cr: c.right, cb: c.bottom,
          vw: innerWidth, vh: innerHeight, ir: getComputedStyle(document.getElementById('c')).imageRendering, tr: document.getElementById('screen').style.transform}; })())""")
        s = json.loads(s)
        seen.add((s["ox"], s["oy"]))
        if not (abs(s["ox"]) <= 3 and abs(s["oy"]) <= 3 and float(s["ox"]).is_integer() and float(s["oy"]).is_integer()):
            bad.append(("range", s))
        if s["ct"] < -0.01 or s["cb"] > s["vh"] + 0.01 or s["cl"] < -0.01 or s["cr"] > s["vw"] + 0.01:
            bad.append(("crop", s))
        time.sleep(0.25)
    check("orbit never leaves +-3 device px / never crops the canvas", not bad, bad[:1])
    check("orbit visits several positions", len(seen) >= 5, sorted(seen))
    check("canvas stays pixelated", s["ir"] in ("pixelated", "crisp-edges"), s["ir"])
    check("screen is 6 device px shorter (margin for the orbit)", abs(s["h"] - (s["vh"] - 3)) < 0.01, s["h"])
    check("transform is in whole device pixels", s["tr"] == "" or all(float(v[:-2]) * s["dpr"] == round(float(v[:-2]) * s["dpr"]) for v in s["tr"][len("translate("):-1].split(",")), s["tr"])

    # ---- daytime look: identical to ?noburn once the orbit is parked and the margin removed (dpr 1 so the diff is per pixel)
    DIFF = """(async (a, b) => { const load = (d) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + d; });
      const [A, B] = [await load(a), await load(b)], c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
      x.clearRect(0, 0, c.width, c.height); x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 30) n++;
      return n / (c.width * c.height); })"""
    best = 1.0
    for _ in range(4):
        P.open("/?hour=12&noburn", dpr=1, settle=4)
        a = P.shot()
        P.open("/?hour=12&orbit=9999", dpr=1, settle=4)
        P.js("document.documentElement.style.setProperty('--bshrink','0px'); RetroBurn.state(); document.getElementById('screen').style.transform=''")
        time.sleep(0.5)
        b = P.shot()
        best = min(best, P.js(f"({DIFF})('{a}', '{b}')", wait=True))
        if best < 0.001:
            break
    check("daytime look identical to ?noburn with the orbit parked (diff <0.1% of pixels)", best < 0.001, f"{best:.5f}")

    # ---- night rest / day dim
    def burn(path, secs):
        P.open(path, settle=secs)
        return P.state()

    s = burn("/?hour=2&restidle=2&dimidle=2", 4)
    check("night, quiet: rests", s["mode"] == "rest", s)
    check("rest veil fades toward near-black", P.js("getComputedStyle(document.getElementById('burn-veil')).transitionDuration") == "45s"
          and float(P.js("document.getElementById('burn-veil').style.opacity")) >= 0.9, "")
    check("rest shrinks the screen", "scale(0.5)" in P.js("document.getElementById('screen').style.transform"))
    P.key("a", "KeyA"); time.sleep(0.6)
    s = P.state()
    check("key wakes instantly", s["mode"] == "day" and float(P.js("getComputedStyle(document.getElementById('burn-veil')).opacity")) < 0.05
          and "scale" not in P.js("document.getElementById('screen').style.transform"), s)
    check("quiet again -> rests again", wait_for(lambda: P.state()["mode"] == "rest", 6) is not None)
    P.mouse(300, 300); P.mouse(320, 330); time.sleep(0.6)
    check("mouse wakes", P.state()["mode"] == "day", P.state())
    wait_for(lambda: P.state()["mode"] == "rest", 6)
    post("/activity", {"agent": "maker", "status": "working", "label": "CODING"}); time.sleep(0.8)
    check("crew activity wakes", P.state()["mode"] == "day", P.state())
    time.sleep(3)
    check("crew still working keeps it awake", P.state()["mode"] == "day", P.state())
    post("/activity", {"agent": "maker", "status": "idle", "label": ""})
    for h, want in ((23.4, "day"), (23.5, "rest"), (5.9, "rest"), (6.0, "day")):
        s = burn(f"/?hour={h}&restidle=1&dimidle=9999", 3.5)
        check(f"clock {h}: {'rest window' if want == 'rest' else 'not night'}", s["mode"] == want, s)
    s = burn("/?hour=14&restidle=1&dimidle=2", 4.5)
    check("daytime quiet: faint dim only, never rest", s["mode"] == "dim" and 0.05 <= s["veil"] <= 0.15, s)
    P.key("b", "KeyB"); time.sleep(0.5)
    check("dim lifts instantly on a key", P.state()["mode"] == "day")
    s = burn("/?hour=14&restidle=1&dimidle=9999", 3.5)
    check("daytime default idle: no dim, no rest", s["mode"] == "day" and s["veil"] == 0, s)

    # ---- clearing mode
    s = burn("/?hour=12&wipe=0.05", 2)
    check("?wipe starts clearing", s["wiping"], s)
    check("wipe overlay covers the screen above the canvas", json.loads(P.js("""JSON.stringify((() => { const c = [...document.querySelectorAll('canvas')].find(x => x.id !== 'c');
        const r = c.getBoundingClientRect(); return { z: getComputedStyle(c).zIndex, full: r.width === innerWidth && r.height === innerHeight }; })())""")) == {"z": "30", "full": True})
    wait_for(lambda: not P.state()["wiping"], 8)
    time.sleep(2.2)
    check("wipe ends by itself and the overlay is removed", not P.state()["wiping"] and P.js("document.querySelectorAll('canvas').length") == 1, P.state())
    s = burn("/?hour=12", 2)
    P.key("w", "KeyW"); time.sleep(0.8)
    check("W starts clearing (20 min)", P.state()["wiping"] and 1190 <= P.state()["wipeLeftS"] <= 1200, P.state())
    check("server was told", health().get("wipe_for", 0) > 1100, health().get("wipe_for"))
    P.key("Escape", "Escape"); time.sleep(0.6)
    check("Esc stops it", not P.state()["wiping"] and health().get("wipe_for") == 0, (P.state(), health().get("wipe_for")))
    P.key("w", "KeyW"); time.sleep(0.6); P.key("w", "KeyW"); time.sleep(0.6)
    check("W again stops it", not P.state()["wiping"], P.state())
    post("/event", {"wipe": 3}); time.sleep(1.0)
    check("POST /event {wipe: 3} starts it on the display", P.state()["wiping"] and 170 <= P.state()["wipeLeftS"] <= 180, P.state())
    P.open("/?hour=12", settle=2.5)
    check("a reloaded display resumes the running wipe", P.state()["wiping"] and P.state()["wipeLeftS"] > 150, P.state())
    post("/event", {"wipe": 0}); time.sleep(0.8)
    check("POST /event {wipe: 0} stops it", not P.state()["wiping"], P.state())

    # coverage + flash rate over one full 60 s colour cycle (20 s of it would miss red/green/blue)
    time.sleep(2.2); post("/event", {"wipe": 2}); time.sleep(0.8)
    SAMPLE = """(() => { const c = [...document.querySelectorAll('canvas')].filter(x => x.id !== 'c').pop(); if (!c) return null; const x = c.getContext('2d'), w = c.width, h = c.height, out = [];
        for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 8; gx++) { const d = x.getImageData(Math.floor((gx + .5) * w / 8), Math.floor((gy + .5) * h / 6), 1, 1).data; out.push(Math.round(.3 * d[0] + .59 * d[1] + .11 * d[2])); }
        return out; })()"""
    samples, t0 = [], time.time()
    while time.time() - t0 < 66:
        v = P.js(SAMPLE)
        if v:
            samples.append((time.time() - t0, v))
        time.sleep(0.1)
    n = len(samples[0][1])
    lo = [min(s[1][i] for s in samples) for i in range(n)]
    hi = [max(s[1][i] for s in samples) for i in range(n)]
    check("clearing: every sampled pixel went dark and light", all(l <= 40 for l in lo) and all(h >= 215 for h in hi), (min(hi), max(lo)))
    # flash rate: count mid-grey crossings (light<->dark flips, 2 per flash) inside any 1 s window; 3 flashes/s = 6 crossings
    worst, where = 0, None
    for i in range(n):
        cross, prev = [], samples[0][1][i] >= 128
        for t, v in samples:
            cur = v[i] >= 128
            if cur != prev:
                cross.append(t)
                prev = cur
        for a in range(len(cross)):
            k = sum(1 for c in cross if cross[a] <= c < cross[a] + 1.0)
            if k > worst:
                worst, where = k, (i, round(cross[a], 1))
    check("clearing: at most 2 light/dark flips per pixel in any second (limit 6 = 3 flashes/s)", worst <= 2, f"{worst} at {where}")
    post("/event", {"wipe": 0})
    P.call("Page.navigate", url="about:blank")
finally:
    try:
        post("/event", {"wipe": 0})
    except Exception:
        pass
    chrome.terminate()
    try:
        chrome.wait(5)
    except Exception:
        chrome.kill()
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("FAILS: %d" % len(FAILS))
for f in FAILS:
    print("  -", f)
sys.exit(1 if FAILS else 0)
