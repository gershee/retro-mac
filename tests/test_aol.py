#!/usr/bin/env python3
"""AOL skin: server-side checks (stdlib only). Starts its own silent testsrv on a spare port, so nothing talks to the kiosk.

  python tests/test_aol.py [port]        (default 8799; never 8787)

Checks: "aol" is a valid theme (POST /event persists it and broadcasts it in the hello settings), junk themes are
rejected, the web files parse (node --check), index.html loads aol.js, server.py imports no Hermes code.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
assert PORT != 8787, "never the live kiosk port"
BASE = f"http://127.0.0.1:{PORT}"
fails = 0


def check(name, got, want=True):  # noqa
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


def req(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data, {"Content-Type": "application/json"}, method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


# ---- static checks (no server needed)
src = (ROOT / "server" / "server.py").read_text()
check("server.py imports no hermes code", bool(re.search(r"^\s*(import|from)\s+hermes", src, re.M)), False)
check("server THEMES has aol", '"aol"' in src.split("SETTINGS_FILE")[0])
check("index.html loads aol.js", 'src="aol.js"' in (ROOT / "web" / "index.html").read_text())
face = (ROOT / "web" / "face.js").read_text()
check("face.js: aol last in the theme cycle", "'paper', 'aol']" in face)
check("face.js: skin hook is gated on T.skin", face.count("T.skin && window.RetroAOL") >= 3)
# theme switcher (mouse/touch, both ways) + screen name
aol = (ROOT / "web" / "aol.js").read_text()
check("aol.js: screen name is a variable, neutral default (no hardcoded personal name)", "let ME = cleanSN(" in aol and "'guest'" in aol)
check("aol.js: no literal 'Gersh' as a user label", bool(re.search(r"Welcome, Gersh|`Gersh's |'Gersh:'|1999 Gersh|iamgershee|Brooklyn", aol)), False)
check("aol.js: taskbar Mac button + Start menu entry call switchSkin(false)", aol.count("api.switchSkin(false)") >= 2)
check("aol.js: away note hidden under the IM window", "function drawAwayNote(ctx, t) {\n    if (A.im) return;" in aol)
check("face.js: tiny AOL tag drawn with the legend, click -> switchSkin(true)", "drawSkinTag();" in face and "switchSkin(true)" in face)
check("face.js: switchSkin exported to the skin", "emote, switchSkin," in face)
check("face.js: remembers the v1 theme for the way back", "store.set('rm-v1theme', name)" in face)
for f in ("aol.js", "face.js", "panels.js", "windows.js", "banner.js"):
    p = subprocess.run(["node", "--check", str(ROOT / "web" / f)], capture_output=True, text=True)
    check(f"node --check {f}", p.returncode == 0 or p.stderr.strip(), True)

# ---- live checks against a private test server
env = dict(os.environ, RETRO_MAC_PORT=str(PORT))
srv = subprocess.Popen([sys.executable, str(ROOT / "tests" / "testsrv.py"), str(ROOT / "server" / "server.py"), str(PORT)],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            if req("/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    else:
        raise SystemExit("test server did not come up")
    st, j = req("/event", {"theme": "aol"})
    check("POST /event theme=aol accepted", (st, j.get("ok"), j.get("theme")), (200, True, "aol"))
    st, j = req("/event", {"theme": "geocities"})
    check("junk theme is not a settings change", j.get("theme"), None)
    st, j = req("/event", {"theme": "green"})
    check("back to green", (st, j.get("theme")), (200, "green"))
    st, j = req("/event", {"theme": "aol", "tone": 0.3})
    check("theme + tone together", (j.get("theme"), j.get("tone")), ("aol", 0.3))
    # the ws hello carries settings: check through the module directly (same code path as the broadcast)
    sys.path.insert(0, str(ROOT / "server"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("srv_static", ROOT / "server" / "server.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    check("THEMES tuple", m.THEMES[-1], "aol")
    check("default theme untouched", m.settings["theme"], "green")
    # AOL screen name: a neutral default, sanitized, never hardcoded in the web code
    cfgm = sys.modules["config"]
    check("screen name defaults to guest", (cfgm.SCREEN_NAME, m.settings_msg()["screen_name"]), ("guest", "guest"))
    check("screen name is not persisted in settings", "screen_name" not in m.settings, True)
    check("clean_screen_name sanitizes", (cfgm.clean_screen_name("  Bob<script>  Smith "), cfgm.clean_screen_name("x"),
                                          cfgm.clean_screen_name("a" * 40), cfgm.clean_screen_name(None)),
          ("Bobscript Smith", "guest", "a" * 16, "guest"))
    check("aol.js reads the screen name from the server", "setScreenName" in aol and "screen_name" in face, True)
finally:
    srv.terminate()
    try:
        srv.wait(timeout=10)
    except Exception:
        srv.kill()
print("FAILED" if fails else "ALL OK", fails)
sys.exit(1 if fails else 0)
