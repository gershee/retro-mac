#!/usr/bin/env python3
"""LIMITS window, offline: scripts/usage_probe.py mapping (fake Hermes snapshots, no Hermes import) and the server's
GET /limits cache (fake probe scripts run with this python; no network, no Hermes).

  venv/bin/python tests/test_limits.py
"""
import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace as NS

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.argv = sys.argv[:1]
os.environ.pop("RETRO_MAC_DEMO", None)
import usage_probe as up  # noqa: E402
import server as s  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


# ---------------------------------------------------------------- probe mapping
reset = datetime(2026, 1, 6, 19, 0, tzinfo=timezone.utc)
snap = NS(unavailable_reason=None, windows=(
    NS(label="Current session", used_percent=78.4, reset_at=reset),
    NS(label="Current week", used_percent=12.0, reset_at=None),
    NS(label="Opus week", used_percent=101.0, reset_at=reset),
    NS(label="Sonnet week", used_percent=-3, reset_at=reset),
    NS(label="Mystery", used_percent=None, reset_at=reset),        # no number: dropped
))
p = up.to_payload(snap, now=1000)
check("ok payload", (p["ok"], p["at"]), (True, 1000))
check("labels mapped", [w["label"] for w in p["windows"]], ["5-HOUR", "WEEK", "OPUS WK", "SONNET WK"])
check("used rounded + clamped 0..100", [w["used"] for w in p["windows"]], [78, 12, 100, 0])
check("reset = epoch seconds, None kept", [p["windows"][0]["reset"], p["windows"][1]["reset"]], [int(reset.timestamp()), None])
check("unknown label upper-cased", up.short_label("Team pool"), "TEAM POOL")
check("None snapshot -> ok false", up.to_payload(None)["ok"], False)
check("unavailable reason passed through",
      up.to_payload(NS(unavailable_reason="Only for OAuth accounts.", windows=()))["error"], "Only for OAuth accounts.")
check("no windows -> ok false", up.to_payload(NS(unavailable_reason=None, windows=()))["error"], "no usage windows reported")
check("error never carries a token", "sk-ant" in up.clean_error("401 for Bearer sk-ant-oat01-abcdefghijklmnop"), False)

# ---------------------------------------------------------------- server /limits cache
tmp = Path(tempfile.mkdtemp())
probe = tmp / "probe.py"


def fake(payload):
    probe.write_text(f"import json\nprint('hermes says hi')\nprint(json.dumps({payload!r}))\n")


async def get():
    r = await s.handle_limits(None)
    return json.loads(r.text), r.headers.get("Cache-Control")


async def main():
    s.USAGE_PROBE = probe
    s.config.HERMES_PYTHON = None
    s.limits_cache.update(tried=0.0, good=None, error="")
    d, cc = await get()
    check("no [limits].python -> not configured", (d, cc), ({"ok": False, "error": "not configured"}, "no-store"))

    s.config.HERMES_PYTHON = Path(sys.executable)
    good = {"ok": True, "at": 123, "windows": [{"label": "5-HOUR", "used": 40, "reset": 999}]}
    fake(good)
    s.limits_cache.update(tried=0.0)
    d, _ = await get()
    check("probe ok -> its windows, last stdout line parsed", (d["ok"], d["stale"], d["windows"]), (True, False, good["windows"]))

    fake({"ok": False, "error": "should be cached"})
    d, _ = await get()
    check("within TTL: cached, probe not rerun", (d["ok"], d["stale"]), (True, False))

    s.limits_cache["tried"] = 0.0
    d, _ = await get()
    check("probe fails -> last good reading marked stale", (d["ok"], d["stale"], d["error"], d["at"]),
          (True, True, "should be cached", 123))

    probe.write_text("print('not json')\n")
    s.limits_cache.update(tried=0.0, good=None, error="")
    d, _ = await get()
    check("garbage output, no cache -> ok false", d["ok"], False)


asyncio.run(main())
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
