#!/usr/bin/env python3
"""Run every test, silently, on a spare port (default 8799). No speakers, no model calls, no real tmux.

  venv/bin/python tests/run_all.py [port]
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RETRO_MAC_TEST_PORT", "8799")
PY = sys.executable
OFFLINE = ["test_text.py", "test_feeds.py", "test_house.py", "test_limits.py", "test_logging.py", "test_dash.py",
           "test_plugin.py"]
SPAWNING = ["test_junk.py", "test_fail.py", "test_security.py", "test_aol.py", "test_crewlog.py"]   # each starts its own testsrv.py on PORT


def run(argv, env=None):
    t0 = time.time()
    p = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, env=env, timeout=600)
    tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
    print(f"{'PASS' if p.returncode == 0 else 'FAIL'}  {Path(argv[1]).name:<18} {time.time() - t0:5.1f}s  {tail[0][:90]}")
    if p.returncode:
        print("\n".join("      " + ln for ln in (p.stdout + p.stderr).splitlines()[-25:]))
    return p.returncode == 0


def wait_up(port, secs=20):
    end = time.time() + secs
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


results = []
for t in OFFLINE:
    if (ROOT / "tests" / t).exists():
        results.append(run([PY, f"tests/{t}"]))
for t in SPAWNING:
    if (ROOT / "tests" / t).exists():
        results.append(run([PY, f"tests/{t}", PORT]))
# push-to-talk needs the fake-TUI test server running alongside
if shutil.which("node"):                     # web clock helpers; browser zone deliberately != the zones tested
    results.append(run(["node", "tests/test_time.js"], env=dict(os.environ, TZ="America/Los_Angeles")))
    results.append(run(["node", "tests/test_lips.js"]))
else:
    print("SKIP  test_time.js, test_lips.js (node not installed)")
srv = subprocess.Popen([PY, "tests/testsrv.py", "server/server.py", PORT], cwd=ROOT,
                       env=dict(os.environ, FAKE_TUI="1"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    results.append(wait_up(PORT) and run([PY, "tests/test_ptt.py", PORT]))
finally:
    srv.terminate()
    srv.wait(5)
# headless-Chrome tests (anti burn-in layer, clock module): need Chrome/Chromium + `pip install -r requirements-dev.txt`.
# They get their own plain test server (the FAKE_TUI one above keeps the crew "active", which would defeat night rest).
sys.path.insert(0, str(ROOT / "tests"))
try:
    import websockets  # noqa: F401
    from clockdrive import CHROME
except Exception:
    CHROME = ""
if CHROME and shutil.which("node"):
    srv = subprocess.Popen([PY, "tests/testsrv.py", "server/server.py", PORT], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if wait_up(PORT):
            for t in ("test_burn.py", "test_clock.py"):
                results.append(run([PY, f"tests/{t}", PORT]))
        else:
            results.append(False)
    finally:
        srv.terminate()
        srv.wait(5)
else:
    print("SKIP  test_burn.py, test_clock.py (need Chrome/Chromium or RETRO_MAC_CHROME, plus pip install -r requirements-dev.txt)")
print(f"\n{sum(results)}/{len(results)} test files passed")
sys.exit(0 if all(results) else 1)
