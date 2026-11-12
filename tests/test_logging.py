#!/usr/bin/env python3
"""Logging, offline: quiet access-log filter, 40-char cap on logged speech/transcripts, 2 MB x 3 rotation.

  venv/bin/python tests/test_logging.py
"""
import logging
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
sys.argv = sys.argv[:1]
import server as s  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


def rec(msg):
    return logging.LogRecord("aiohttp.access", logging.INFO, __file__, 1, msg, None, None)


q = s.QuietAccess()
for path in ('"GET /health HTTP/1.1"', '"POST /level HTTP/1.1"', '"POST /activity HTTP/1.1"', '"GET /house HTTP/1.1"'):
    check(f"quiet: {path}", q.filter(rec(f'127.0.0.1 [12/Nov/2026:10:00:00 -0500] {path} 200 155 "-" "curl"')), False)
for path in ('"POST /speak HTTP/1.1"', '"GET / HTTP/1.1"', '"POST /refresh HTTP/1.1"'):
    check(f"logged: {path}", q.filter(rec(f'127.0.0.1 [12/Nov/2026:10:00:00 -0500] {path} 200 155 "-" "curl"')), True)

long = "Your dentist appointment moved to Thursday at three, and the plumber is coming Friday."
check("snip: 40 chars + ellipsis", s.snip(long), long[:40] + "...")
check("snip: short text unchanged", s.snip("  Done.\n "), "Done.")
check("snip: exactly 40 kept", s.snip("x" * 40), "x" * 40)

with tempfile.TemporaryDirectory() as d:
    f = Path(d) / "server.log"
    fh = s.setup_logging(console=False, log_file=f)
    lg = logging.getLogger("retro-mac.test")
    line = "y" * 1000
    for _ in range(9000):                       # ~9 MB through a 2 MB x 3 handler
        lg.info(line)
    fh.flush()
    files = sorted(p.name for p in Path(d).iterdir())
    check("rotation: server.log + 3 backups, no more", files, ["server.log", "server.log.1", "server.log.2", "server.log.3"])
    check("rotation: every file <= 2 MB", all(p.stat().st_size <= 2 * 1024 * 1024 for p in Path(d).iterdir()), True)
    logging.getLogger().removeHandler(fh)
    fh.close()
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
