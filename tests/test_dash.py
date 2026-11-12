#!/usr/bin/env python3
"""Dashboard loop, offline (fake feeds, no network): a feed that raises does not kill dash_loop, /health reports
dash_age.

  venv/bin/python tests/test_dash.py
"""
import asyncio
import json
import sys
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


async def health():
    return json.loads((await s.handle_health(None)).text)


s.log.disabled = True                          # the expected traceback would only clutter the output
F = s.feeds
F.get_weather = lambda: {"temp": 50, "lines": []}
F.fetch_events = lambda: []
F.load_attention = lambda: []
boom = {"n": 0}


def bad_reminders():
    boom["n"] += 1
    if boom["n"] == 1:
        raise ValueError("bad cron row")
    return []


F.load_reminders = bad_reminders
s.DASH_EVERY = 0.05


async def main():
    check("health: dash_age None before the first pass", (await health())["dash_age"], None)
    task = asyncio.create_task(s.dash_loop())
    await asyncio.sleep(0.4)
    check("loop survived a raising feed (and kept going)", (task.done(), boom["n"] >= 3), (False, True))
    check("agenda built after the failure", s.dash["agenda"][-1]["title"], "NOTHING ELSE TODAY")
    age = (await health())["dash_age"]
    check("health: dash_age is fresh", isinstance(age, float) and age < 1.0, True)
    task.cancel()


asyncio.run(main())
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
