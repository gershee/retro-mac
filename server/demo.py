"""Demo mode: built-in sample data so the kiosk runs anywhere (no Hermes, no calendar, no network).

Everything here is invented. Times are relative to "now" so the dashboard always looks alive.
Enable with `./start.sh --demo` or RETRO_MAC_DEMO=1.
"""
import asyncio
import random
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import config

TZ = ZoneInfo(config.TZ_NAME)


def _hr(dt):
    return f"{dt.hour % 12 or 12}{'A' if dt.hour < 12 else 'P'}"


def weather() -> dict:
    now = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
    base = [52, 53, 55, 57, 58, 58, 57, 55, 53, 51, 50, 49, 48, 47, 46, 46, 45, 45, 46, 48, 50, 53, 55, 56,
            57, 57, 56, 54, 52, 51]
    pops = [5, 5, 10, 15, 30, 60, 75, 70, 40, 20, 10, 5, 5, 5, 5, 5, 5, 5, 10, 10, 15, 20, 20, 15,
            10, 10, 10, 5, 5, 5]
    hours = []
    for i in range(30):
        t = now + timedelta(hours=i)
        p = pops[i]
        icon = "rain" if p >= 55 else "cloud" if p >= 25 else "partly" if i % 7 else "clear"
        hours.append({"h": t.isoformat(), "temp": base[i], "pop": p, "icon": icon, "snow": 0})
    hourly = [{"t": _hr(now + timedelta(hours=i)), "temp": h["temp"], "pop": h["pop"], "icon": h["icon"], "snow": 0}
              for i, h in enumerate(hours[:12])]
    rs, re_ = now + timedelta(hours=5), now + timedelta(hours=8)
    days = [now.date() + timedelta(days=j) for j in range(3)]
    return {
        "temp": 56, "feels": 53, "wind": 9, "hi": 61, "lo": 47, "gust": 17,
        "cond": "PARTLY CLOUDY", "icon": "partly", "alert": "RAIN",
        "lines": [{"t": f"RAIN {_hr(rs)}-{_hr(re_)}  UMBRELLA", "hot": True},
                  {"t": "COOL  LIGHT JACKET", "hot": False}],
        "hourly": hourly, "hours": hours,
        "noon": {"temp": 58, "pop": 10, "cond": "MOSTLY CLEAR", "icon": "clear"},
        "daily": [{"d": "TODAY" if j == 0 else d.strftime("%a").upper(), "hi": hi, "lo": lo, "pop": pop,
                   "cond": c, "icon": ic}
                  for j, (d, (hi, lo, pop, c, ic)) in enumerate(zip(days, [(61, 47, 75, "SHOWERS", "rain"),
                                                                           (63, 49, 10, "MOSTLY CLEAR", "clear"),
                                                                           (59, 46, 30, "OVERCAST", "cloud")]))],
    }


def events() -> list:
    """Sample calendar, shaped like feeds.fetch_events() output."""
    now = datetime.now(TZ)
    d0 = now.replace(hour=0, minute=0, second=0, microsecond=0)

    def at(day, h, m=0):
        return d0 + timedelta(days=day, hours=h, minutes=m)

    rows = [
        (at(0, 9, 30), 15, "Team standup"),
        (at(0, 11), 60, "Design review: kiosk v2"),
        (at(0, 12, 30), 60, "Lunch with Sam"),
        (at(0, 15, 15), 30, "School pickup"),
        (at(0, 16), 45, "1:1 with Robin"),
        (at(0, 18, 30), 90, "Climbing gym"),
        (at(1, 8, 30), 60, "Dentist"),
        (at(1, 10), 30, "Ship the demo build"),
    ]
    # keep something "next" on screen whatever the hour
    if now.hour >= 17:
        rows.append((now + timedelta(minutes=50), 30, "Call with the build crew"))
    out = [{"title": t, "start": s.isoformat(), "end": (s + timedelta(minutes=mins)).isoformat(), "all": False}
           for s, mins, t in rows]
    out.append({"title": "Hack week", "start": d0.isoformat(), "end": (d0 + timedelta(days=1)).isoformat(), "all": True})
    return out


def reminders() -> list:
    now = datetime.now(TZ)
    return [{"title": "Water the plants", "at": (now + timedelta(hours=2)).replace(minute=0, second=0).isoformat()}]


ATTENTION = ["Reply to Robin about Friday"]


def house(n_displays: int, ptt_on: bool) -> dict:
    now = time.time()
    svc = [
        {"name": "GATEWAY", "up": True, "note": "RUNNING"},
        {"name": "MESSAGING", "up": True, "note": "CONNECTED"},
        {"name": "NAS", "up": True, "note": "HTTP 200"},
        {"name": "KIOSK", "up": n_displays > 0, "note": f"{n_displays} DISPLAY" + ("S" if n_displays != 1 else "")},
        {"name": "VOICE", "up": True, "note": "READY"},
        {"name": "WAKE / MIC", "up": True, "note": "PTT MODE" if ptt_on else "LISTENING"},
    ]
    jobs = [{"ts": now - 4 * 3600, "name": "MORNING BRIEFING", "st": "DONE"},
            {"ts": now - 3600, "name": "INBOX TRIAGE", "st": "DONE"},
            {"ts": now + 2 * 3600, "name": "WATER THE PLANTS", "st": "NEXT"},
            {"ts": now + 5 * 3600, "name": "EVENING WRAP-UP", "st": "LATER"}]
    return {"ok": True, "at": now, "services": svc,
            "mic": {"ptt": ptt_on, "open": False, "note": "MIC CLOSED (IDLE)" if ptt_on else "WAKE WORD ON, MIC LIVE"},
            "disk": {"free_gb": 182.4, "total_gb": 500, "pct_free": 36},
            "audit": {"at": datetime.fromtimestamp(now - 6 * 3600).isoformat(), "ok": True, "sev": "LOW",
                      "line": "ALL CHECKS PASSED", "alert": False},
            "next_job": {"name": "WATER THE PLANTS", "ts": now + 2 * 3600}, "jobs": jobs, "alerts": [],
            "attention": [{"t": t, "since": now - 1800} for t in ATTENTION]}


def limits() -> dict:
    """Sample Claude plan usage for the LIMITS window (same shape as scripts/usage_probe.py output)."""
    now = time.time()
    nxt = datetime.fromtimestamp(now, TZ) + timedelta(days=4)
    week_reset = nxt.replace(hour=14, minute=0, second=0, microsecond=0).timestamp()
    return {"ok": True, "at": int(now), "windows": [
        {"label": "5-HOUR", "used": 62, "reset": int(now + 2 * 3600 + 17 * 60)},
        {"label": "WEEK", "used": 34, "reset": int(week_reset)},
        {"label": "OPUS WK", "used": 91, "reset": int(week_reset)},
    ]}


# A small script so the CREW panel is never empty in demo mode.
CREW_SCRIPT = [
    ("scout", "working", "RESEARCHING"), ("maker", "working", "BUILDING"), (None, None, None),
    ("scout", "thinking", "READING PAGE"), ("maker", "working", "RUNNING TESTS"), ("scout", "idle", ""),
    (None, None, None), ("maker", "idle", ""), ("alfred", "thinking", "THINKING"), ("alfred", "idle", ""),
]


async def crew_loop(set_crew):
    i = 0
    await asyncio.sleep(3)
    while True:
        agent, status, label = CREW_SCRIPT[i % len(CREW_SCRIPT)]
        if agent:
            await set_crew(agent, status, label)
        i += 1
        await asyncio.sleep(random.uniform(9, 16))


def seed_crewlog(crewlog) -> None:
    """Fill today's demo journal (LOG window, key 7; About box tallies) with invented entries, spread over the
    last few hours. Nothing here is real. Skipped when the demo journal already has entries today."""
    if crewlog.entries:
        return
    now = time.time()
    local = datetime.now(TZ)
    since_midnight = (local - local.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds() / 60
    k = min(1.0, max(0.05, (since_midnight - 2) / 320))   # early in the day: squeeze the sample into today
    rows = [  # (minutes ago, kind, agent, text, took seconds)
        (310, "asked", "alfred", "What is on my calendar today", 0),
        (309, "reply", "alfred", "You have a stand-up at nine thirty and a design review at eleven.", 0),
        (265, "done", "scout", "RESEARCHING", 74),
        (240, "done", "maker", "BUILDING", 188),
        (236, "reply", "maker", "The demo build is ready to ship.", 0),
        (180, "done", "maker", "RUNNING TESTS", 41),
        (150, "asked", "scout", "Find three sample datasets for the kiosk", 0),
        (146, "done", "scout", "READING PAGE", 33),
        (145, "reply", "scout", "I found three datasets, all small and free to use.", 0),
        (95, "done", "alfred", "THINKING", 12),
        (60, "failed", "alfred", "LIMIT HIT: sample provider limit, retrying later", 0),
        (35, "done", "maker", "WRITING DOCS", 97),
        (12, "reply", "alfred", "Everything is running smoothly, nothing urgent.", 0),
    ]
    real_now = crewlog.now
    try:
        for mins, kind, agent, text, took in rows:
            crewlog.now = lambda m=mins: now - m * k * 60
            crewlog.add(kind, agent, text, took=took)
    finally:
        crewlog.now = real_now
