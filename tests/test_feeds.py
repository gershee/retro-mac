#!/usr/bin/env python3
"""Dashboard feeds, offline, on a fake clock: agenda + reminder day labels (today / TMR / weekday), live and ended
events, all-day rows, attention rows, the empty state, and the TODAY timeline.

  venv/bin/python tests/test_feeds.py
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
sys.argv = sys.argv[:1]
import feeds  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


TZ = feeds.TZ
NOW = datetime(2026, 11, 12, 10, 0, tzinfo=TZ)           # a Thursday, 10:00 local
feeds._now = lambda: NOW


def at(days, h, m=0):
    return (NOW.replace(hour=h, minute=m) + timedelta(days=days)).isoformat()


def ev(title, d, h, dur=1, all_day=False):
    s = NOW.replace(hour=h, minute=0) + timedelta(days=d)
    if all_day:
        s = s.replace(hour=0)
        return {"title": title, "start": s.isoformat(), "end": (s + timedelta(days=1)).isoformat(), "all": True}
    return {"title": title, "start": s.isoformat(), "end": (s + timedelta(hours=dur)).isoformat(), "all": False}


def labels(rows):
    return [(r["k"], r["t"], r["title"]) for r in rows if not r.get("x")]


# reminders: the same day rule as events, weekday for 2-3 days out (was "TMR" for everything not today)
rem = [{"title": "Call the bank", "at": at(0, 15)}, {"title": "Water plants", "at": at(1, 9)},
       {"title": "Pay rent", "at": at(2, 9)}, {"title": "Renew pass", "at": at(3, 18, 30)}]
rows = feeds.build_agenda([], rem, [])
check("reminder labels: today / TMR / SAT / SUN", labels(rows),
      [("remind", "3:00P", "Call the bank"), ("remind", "TMR 9:00A", "Water plants"),
       ("remind", "SAT 9:00A", "Pay rent"), ("remind", "SUN 6:30P", "Renew pass")])

events = [ev("Standup", 0, 9, 2), ev("Ended", 0, 8), ev("Lunch", 0, 12), ev("Dentist", 1, 8),
          ev("Too far", 2, 9), ev("Holiday", 0, 0, all_day=True)]
rows = feeds.build_agenda(events, [], ["Renew passport"])
check("agenda: attention, all-day, live, today, TMR; ended + day-after dropped", labels(rows),
      [("attn", "!", "Renew passport"), ("event", "ALL", "Holiday"), ("event", "9:00A", "Standup"),
       ("event", "12:00P", "Lunch"), ("event", "TMR 8:00A", "Dentist")])
check("agenda: running event flagged now", [r.get("now") for r in rows if r["title"] in ("Standup", "Lunch")],
      [True, False])
check("agenda: empty -> NOTHING ELSE TODAY", labels(feeds.build_agenda([], [], [])),
      [("none", "", "NOTHING ELSE TODAY")])
check("agenda: today first, then later days", [r["title"] for r in feeds.build_agenda(
    [ev("Lunch", 0, 12)], [{"title": "Early", "at": at(1, 7)}], [])], ["Lunch", "Early"])
many = [ev(f"E{i}", 0, 11 + i // 2) for i in range(12)]
rows = feeds.build_agenda(many, rem, [])
check("agenda: overflow rows flagged x for the big TODAY window", (len([r for r in rows if not r.get("x")]),
                                                                   all(r.get("x") for r in rows[9:])), (9, True))
check("day prefix helper", [feeds._day_prefix(NOW + timedelta(days=d), NOW.date()) for d in range(4)],
      ["", "TMR ", "SAT ", "SUN "])

day = feeds.day_timeline(events, rem)
check("timeline: date", day["date"], "THU NOV 12")
check("timeline: today's timed rows incl. past", [r["title"] for r in day["events"]],
      ["Ended", "Standup", "Lunch", "Call the bank"])
check("timeline: tomorrow morning", [r["title"] for r in day["tmr"]], ["Dentist", "Water plants"])
check("timeline: all-day", day["allday"], ["Holiday"])

# calendars: per-calendar results; a failing calendar keeps its old events, an empty success clears them
FIX = Path(__file__).resolve().parent / "fixtures"
feeds.CAL_COMMAND = [sys.executable, str(FIX / "fake_cal.py"), "{calendar}", "{start}", "{end}"]
feeds.CALENDARS = ["work", "home", "bad", "empty"]
res = feeds.fetch_calendars()
check("fetch: ok/fail per calendar", {k: v["ok"] for k, v in res.items()},
      {"work": True, "home": True, "bad": False, "empty": True})
check("fetch: failure carries the reason", "token expired" in res["bad"]["error"], True)
check("fetch: cancelled dropped, both start shapes parsed", [e["title"] for e in res["work"]["events"]],
      ["work standup", "Shared lunch"])
cals, merged, failed = feeds.merge_calendars({}, res)
check("merge: shared event shown once", [e["title"] for e in merged], ["work standup", "Shared lunch", "home standup"])
check("merge: failed list", [c for c, _ in failed], ["bad"])
x = {"title": "Old bad-cal event", "start": at(0, 14), "end": at(0, 15), "all": False}
y = {"title": "Deleted event", "start": at(0, 16), "end": at(0, 17), "all": False}
cals, merged, failed = feeds.merge_calendars({"bad": [x], "empty": [y]}, res)
check("merge: failed calendar keeps its previous events", cals["bad"], [x])
check("merge: empty successful result clears the calendar", cals["empty"], [])
check("merge: merged list = kept + fresh", [e["title"] for e in merged],
      ["work standup", "Shared lunch", "home standup", "Old bad-cal event"])
cals, merged, _ = feeds.merge_calendars({"gone": [x]}, {"work": res["work"]})
check("merge: calendar removed from config is dropped", (list(cals), len(merged)), (["work"], 2))
feeds.CAL_COMMAND = []
check("fetch: no command -> no calendars", feeds.fetch_calendars(), {})
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
