#!/usr/bin/env python3
"""Run every test, silently, on a spare port (default 8799). No speakers, no model calls, no real tmux.

  venv/bin/python tests/run_all.py [port]
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RETRO_MAC_TEST_PORT", "8799")
PY = sys.executable
OFFLINE = ["test_text.py", "test_feeds.py", "test_house.py", "test_logging.py", "test_dash.py"]
SPAWNING = ["test_junk.py", "test_fail.py", "test_security.py"]   # each starts its own testsrv.py on PORT


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
srv = subprocess.Popen([PY, "tests/testsrv.py", "server/server.py", PORT], cwd=ROOT,
                       env=dict(os.environ, FAKE_TUI="1"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    results.append(wait_up(PORT) and run([PY, "tests/test_ptt.py", PORT]))
finally:
    srv.terminate()
    srv.wait(5)
print(f"\n{sum(results)}/{len(results)} test files passed")
sys.exit(0 if all(results) else 1)
