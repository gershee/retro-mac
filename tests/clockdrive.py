#!/usr/bin/env python3
"""Shared headless-Chrome driver for the clock tests + mockup capture (test pages only; always --mute-audio, never the live kiosk).

  from clockdrive import Chrome
  with Chrome(port=8795) as P:
      P.open('/?test&clock=flip&hour=14')
      P.hide_test_ui()
      P.save('out.png')          # exactly the 1024x684 canvas (2x of 512x342)
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

from websockets.sync.client import connect

CHROME = os.environ.get("RETRO_MAC_CHROME") or next((p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or "") if p and os.path.exists(p)), "")
CDP = 9462


class Chrome:
    def __init__(self, port=8795, cdp=CDP, w=1030, h=690, dpr=1):
        self.base = f"http://127.0.0.1:{port}"
        self.cdp, self.w, self.h, self.dpr = cdp, w, h, dpr
        self.n = 0

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="clock-chrome-", dir=os.environ.get("TMPDIR") or None)
        self.proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={self.cdp}", f"--user-data-dir={self.tmp}",
                                      "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
                                      f"--window-size={self.w},{self.h}", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tabs = None
        for _ in range(75):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{self.cdp}/json/list", timeout=2).read())
                break
            except Exception:
                time.sleep(0.2)
        tab = next(t for t in tabs if t.get("type") == "page")
        self.ws = connect(tab["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024, open_timeout=10)
        self.call("Page.enable")
        return self

    def __exit__(self, *a):
        try:
            self.ws.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv(timeout=60))
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})

    def js(self, expr, wait=False):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=wait)
        if "exceptionDetails" in r:
            raise RuntimeError(str(r["exceptionDetails"])[:400])
        return r["result"].get("value")

    def open(self, path, settle=2.0):
        self.call("Emulation.setDeviceMetricsOverride", width=self.w, height=self.h, deviceScaleFactor=self.dpr, mobile=False)
        self.call("Page.navigate", url=self.base + path)
        time.sleep(settle)

    def key(self, key, code):
        for t in ("keyDown", "keyUp"):
            self.call("Input.dispatchKeyEvent", type=t, key=key, code=code, text=key if t == "keyDown" and len(key) == 1 else "")

    def mouse(self, x, y):
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)

    def click_canvas(self, cx, cy):
        """click at canvas coordinates (512x342 space)"""
        r = json.loads(self.js("JSON.stringify(document.getElementById('c').getBoundingClientRect())"))
        x, y = r["left"] + cx * r["width"] / 512, r["top"] + cy * r["height"] / 342
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", type=t, x=x, y=y, button="left", clickCount=1)

    def hide_test_ui(self):
        self.js("for (const id of ['test','dbg','tonebox']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } document.body.style.cursor='none'; 0")

    def shot(self, full=False):
        if full:
            return base64.b64decode(self.call("Page.captureScreenshot", format="png")["data"])
        r = json.loads(self.js("JSON.stringify(document.getElementById('c').getBoundingClientRect())"))
        clip = {"x": r["left"], "y": r["top"], "width": r["width"], "height": r["height"], "scale": 1}
        return base64.b64decode(self.call("Page.captureScreenshot", format="png", clip=clip)["data"])

    def save(self, path, full=False):
        with open(path, "wb") as f:
            f.write(self.shot(full))
        return path

    def frames(self, outdir, secs, full=False, every=0.0):
        """grab frames as fast as Chrome allows for `secs`; returns measured fps"""
        os.makedirs(outdir, exist_ok=True)
        t0, n = time.time(), 0
        while time.time() - t0 < secs:
            self.save(os.path.join(outdir, f"f{n:05d}.png"), full)
            n += 1
            if every:
                time.sleep(every)
        return n / (time.time() - t0)

    def clock(self):
        return json.loads(self.js("JSON.stringify(RetroClock.state())"))

    def ascii(self, x0, y0, x1, y1, step=1):
        """code-side truth: dump canvas pixels (lit = '#') for a region in 512x342 canvas coordinates"""
        rows = self.js("(() => { const d = document.getElementById('c').getContext('2d').getImageData(%d, %d, %d, %d).data, w = %d, out = [];"
                       " for (let y = 0; y < %d; y += %d) { let s = ''; for (let x = 0; x < w; x += %d) s += d[(y * w + x) * 4 + 1] > 100 ? '#' : '.'; out.push(s); } return out; })()"
                       % (x0, y0, x1 - x0, y1 - y0, x1 - x0, y1 - y0, step, step))
        return "\n".join(f"{y0 + i * step:3d} {r}" for i, r in enumerate(rows))
