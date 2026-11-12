"""Data feeds for the Retro Mac dashboard: weather advice + a "today" agenda.

All fetching is outbound-only (Open-Meteo, an optional calendar command from config.toml, the local Hermes
cron file). Nothing here listens on a port. In demo mode (config.DEMO) every source is replaced by demo.py
sample data and nothing leaves the machine.
"""
import json
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import config

TZ = ZoneInfo(config.TZ_NAME)
LOC = config.CFG["location"]
PLACE = str(LOC.get("name") or "WEATHER").upper()[:16]
LAT, LON = float(LOC["latitude"]), float(LOC["longitude"])

CAL_COMMAND = list(config.CFG["calendar"].get("command") or [])
CALENDARS = list(config.CFG["calendar"].get("calendars") or ["primary"])
CRON_JOBS = config.HERMES_HOME / "cron" / "jobs.json"
ATTENTION_FILE = config.DATA_DIR / "attention.json"

WMO = {
    0: ("CLEAR", "clear"), 1: ("MOSTLY CLEAR", "clear"), 2: ("PARTLY CLOUDY", "partly"),
    3: ("OVERCAST", "cloud"), 45: ("FOG", "cloud"), 48: ("FOG", "cloud"),
    51: ("DRIZZLE", "rain"), 53: ("DRIZZLE", "rain"), 55: ("DRIZZLE", "rain"),
    56: ("FREEZING DRIZZLE", "snow"), 57: ("FREEZING DRIZZLE", "snow"),
    61: ("RAIN", "rain"), 63: ("RAIN", "rain"), 65: ("HEAVY RAIN", "rain"),
    66: ("FREEZING RAIN", "snow"), 67: ("FREEZING RAIN", "snow"),
    71: ("SNOW", "snow"), 73: ("SNOW", "snow"), 75: ("HEAVY SNOW", "snow"), 77: ("SNOW GRAINS", "snow"),
    80: ("SHOWERS", "rain"), 81: ("SHOWERS", "rain"), 82: ("HEAVY SHOWERS", "rain"),
    85: ("SNOW SHOWERS", "snow"), 86: ("SNOW SHOWERS", "snow"),
    95: ("THUNDERSTORM", "storm"), 96: ("THUNDERSTORM", "storm"), 99: ("THUNDERSTORM", "storm"),
}


def _now() -> datetime:
    """The clock every feed uses (tests replace it with a fixed time)."""
    return datetime.now(TZ)


def _day_prefix(dt: datetime, today) -> str:
    """Agenda day label, one rule for events and reminders: today -> "", tomorrow -> "TMR ", later -> "SAT "."""
    if dt.date() == today:
        return ""
    if dt.date() == today + timedelta(days=1):
        return "TMR "
    return dt.strftime("%a ").upper()


def _hr(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}{'A' if dt.hour < 12 else 'P'}"


def _clock(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d}{'A' if dt.hour < 12 else 'P'}"


# --------------------------------------------------------------------- weather
def get_weather() -> dict:
    if config.DEMO:
        import demo
        return dict(demo.weather(), place=PLACE)
    url = (
        "https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m"
        "&hourly=temperature_2m,precipitation_probability,precipitation,snowfall,weather_code"
        "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max"
        "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch"
        "&timezone=%s&forecast_days=3" % (LAT, LON, urllib.parse.quote(config.TZ_NAME, safe=""))
    )
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "retro-mac"}), timeout=15) as r:
        d = json.load(r)
    cur, hr, day = d["current"], d["hourly"], d["daily"]
    now = _now().replace(minute=0, second=0, microsecond=0)
    times = [datetime.fromisoformat(t).replace(tzinfo=TZ) for t in hr["time"]]
    start = next((i for i, t in enumerate(times) if t >= now), 0)
    # look ahead through tomorrow noon (at least 18h) so tomorrow's school-run weather is caught
    noon_tmr = (now + timedelta(days=1)).replace(hour=12)
    span = max(18, int((noon_tmr - now).total_seconds() // 3600))
    horizon = range(start, min(start + span, len(times)))

    windows, cur_w = [], None
    for i in horizon:
        prob = hr["precipitation_probability"][i] or 0
        pr = hr["precipitation"][i] or 0
        sn = hr["snowfall"][i] or 0
        t = hr["temperature_2m"][i]
        wet = (prob >= 45 and pr >= 0.005) or pr >= 0.03 or sn >= 0.05
        snowy = sn > 0.01 or (wet and t <= 33)
        if wet:
            if cur_w is None:
                cur_w = {"start": times[i], "end": times[i] + timedelta(hours=1), "peak": prob, "snow_in": 0.0, "snowy": 0, "n": 0, "rain_in": 0.0}
                windows.append(cur_w)
            cur_w["end"] = times[i] + timedelta(hours=1)
            cur_w["peak"] = max(cur_w["peak"], prob)
            cur_w["snow_in"] += sn
            cur_w["rain_in"] += pr
            cur_w["snowy"] += 1 if snowy else 0
            cur_w["n"] += 1
        else:
            cur_w = None

    def label(w):
        s = w["start"]
        a = "NOW" if s <= now else _hr(s)
        pre = "" if s.date() == now.date() else "TMR "
        kind = "SNOW" if w["snowy"] * 2 >= w["n"] else "RAIN"
        amt = ""
        if kind == "SNOW" and w["snow_in"] >= 0.2:
            amt = " ~%.0fIN" % max(1, round(w["snow_in"]))
        elif kind == "RAIN" and w["rain_in"] >= 0.3:
            amt = " HEAVY"
        gear = "BOOTS+COAT" if kind == "SNOW" else "UMBRELLA"
        return kind, f"{pre}{kind} {a}-{_hr(w['end'])}{amt}", gear

    lines, alert = [], None
    for w in windows[:2]:
        kind, text, gear = label(w)
        lines.append({"t": f"{text}  {gear}", "hot": True})
        alert = alert or kind
    if not windows:
        lines.append({"t": "NO RAIN OR SNOW AHEAD", "hot": False})

    feels = round(cur["apparent_temperature"])
    wind = round(cur["wind_speed_10m"])
    gust = round(cur.get("wind_gusts_10m") or 0)
    low12 = min(hr["temperature_2m"][i] for i in list(horizon)[:12])
    if low12 <= 32:
        lines.append({"t": "FREEZING TONIGHT  LAYER UP", "hot": True})
    elif feels < 45:
        lines.append({"t": "COLD  WEAR A COAT", "hot": False})
    elif feels < 60:
        lines.append({"t": "COOL  LIGHT JACKET", "hot": False})
    elif feels >= 85:
        lines.append({"t": "HOT  BRING WATER", "hot": False})
    if max(wind, gust) >= 25:
        lines.append({"t": f"WINDY  GUSTS {max(wind, gust)} MPH", "hot": True})

    cond, icon = WMO.get(cur["weather_code"], ("--", "cloud"))
    if alert == "SNOW" and windows and windows[0]["start"] <= now + timedelta(hours=1):
        cond, icon = "SNOW", "snow"
    elif alert == "RAIN" and windows and windows[0]["start"] <= now + timedelta(hours=1) and icon in ("clear", "partly", "cloud"):
        cond, icon = "RAIN", "rain"
    # detail for the enlarged weather panel: next 12 hours + 3-day outlook (best effort)
    hourly, daily, hours, noon = [], [], [], None
    try:
        for i in list(horizon)[:12]:
            hourly.append({"t": _hr(times[i]), "temp": round(hr["temperature_2m"][i]),
                           "pop": int(hr["precipitation_probability"][i] or 0),
                           "icon": WMO.get(hr["weather_code"][i], ("--", "cloud"))[1],
                           "snow": 1 if (hr["snowfall"][i] or 0) > 0.01 else 0})
        # v1.1 click-in windows: next ~30 h by ISO hour (school-run prep, tomorrow morning) + tomorrow noon outlook
        for i in range(start, min(start + 30, len(times))):
            hours.append({"h": times[i].isoformat(), "temp": round(hr["temperature_2m"][i]),
                          "pop": int(hr["precipitation_probability"][i] or 0),
                          "icon": WMO.get(hr["weather_code"][i], ("--", "cloud"))[1],
                          "snow": 1 if (hr["snowfall"][i] or 0) > 0.01 else 0})
        if noon_tmr in times:
            k = times.index(noon_tmr)
            nc, ni = WMO.get(hr["weather_code"][k], ("--", "cloud"))
            noon = {"temp": round(hr["temperature_2m"][k]), "pop": int(hr["precipitation_probability"][k] or 0),
                    "cond": nc, "icon": ni}
        for j, ds in enumerate(day["time"][:3]):
            dd = datetime.fromisoformat(ds).date()
            name = "TODAY" if dd == now.date() else dd.strftime("%a").upper()
            dc, di = WMO.get((day.get("weather_code") or [None] * 3)[j], ("--", "cloud"))
            daily.append({"d": name, "hi": round(day["temperature_2m_max"][j]), "lo": round(day["temperature_2m_min"][j]),
                          "pop": int((day.get("precipitation_probability_max") or [0] * 3)[j] or 0), "cond": dc, "icon": di})
    except Exception:
        pass
    return {
        "temp": round(cur["temperature_2m"]), "feels": feels, "wind": wind,
        "hi": round(day["temperature_2m_max"][0]), "lo": round(day["temperature_2m_min"][0]),
        "cond": cond, "icon": icon, "lines": lines[:4], "alert": alert,
        "hourly": hourly, "daily": daily, "hours": hours, "noon": noon, "gust": gust,
    }


# ---------------------------------------------------------------------- agenda
def _parse_dt(s):
    if isinstance(s, dict):                     # raw Google Calendar API shape {"dateTime": ...} / {"date": ...}
        s = s.get("dateTime") or s.get("date") or ""
    if "T" in s:
        return datetime.fromisoformat(s).astimezone(TZ), False
    return datetime.fromisoformat(s).replace(tzinfo=TZ), True  # all-day


def fetch_events() -> list:
    """Run config.toml [calendar].command once per calendar ({calendar}, {start}, {end} are substituted) and parse
    the JSON list it prints (Google Calendar API event shape: summary, start, end, status; text before the first
    '[' is ignored)."""
    if config.DEMO:
        import demo
        return demo.events()
    if not CAL_COMMAND:
        return []
    now = _now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=2)
    events, seen = [], set()
    for cal in CALENDARS:
        try:
            argv = [str(a).format(calendar=cal, start=start.isoformat(), end=end.isoformat()) for a in CAL_COMMAND]
            argv[0] = str(config._expand(argv[0]))
            out = subprocess.run(argv, capture_output=True, text=True, timeout=60).stdout
            data = json.loads(out[out.index("["):])
        except Exception:
            continue
        for e in data:
            if e.get("status") == "cancelled":
                continue
            key = (e.get("summary"), e.get("start"))
            if key in seen:
                continue
            seen.add(key)
            try:
                s, s_all = _parse_dt(e["start"])
                en, _ = _parse_dt(e["end"])
            except Exception:
                continue
            events.append({"title": e.get("summary") or "(no title)", "start": s.isoformat(), "end": en.isoformat(), "all": s_all})
    return events


def load_reminders() -> list:
    """One-shot Hermes cron reminders firing in the next 3 days."""
    if config.DEMO:
        import demo
        return demo.reminders()
    try:
        d = json.loads(CRON_JOBS.read_text())
        jobs = d["jobs"] if isinstance(d, dict) else d
    except Exception:
        return []
    now = _now()
    out = []
    for j in jobs:
        sched = j.get("schedule") or {}
        if not j.get("enabled") or sched.get("kind") != "once" or not j.get("next_run_at"):
            continue
        try:
            at = datetime.fromisoformat(j["next_run_at"]).astimezone(TZ)
        except Exception:
            continue
        if now <= at <= now + timedelta(days=3):
            out.append({"title": j.get("name", "Reminder"), "at": at.isoformat()})
    return out


def load_attention() -> list:
    if config.DEMO and not ATTENTION_FILE.exists():
        import demo
        return list(demo.ATTENTION)
    try:
        d = json.loads(ATTENTION_FILE.read_text())
        return [str(x) for x in d][:5]
    except Exception:
        return []


def day_timeline(events: list, reminders: list) -> dict:
    """v1.1 TODAY window: all of today's timed events (past ones too) + tomorrow morning (before 1 PM)."""
    now = _now()
    today, tmr = now.date(), now.date() + timedelta(days=1)
    day, morning, allday = [], [], []
    for e in events:
        s, en = datetime.fromisoformat(e["start"]), datetime.fromisoformat(e["end"])
        if e["all"]:
            if s.date() <= today < en.date():
                allday.append(e["title"][:40])
            continue
        row = {"s": s.isoformat(), "e": en.isoformat(), "title": e["title"][:60], "k": "event"}
        if s.date() == today:
            day.append(row)
        elif s.date() == tmr and s.hour < 13:
            morning.append(row)
    for r in reminders:
        at = datetime.fromisoformat(r["at"])
        row = {"s": at.isoformat(), "e": at.isoformat(), "title": r["title"][:60], "k": "remind"}
        if at.date() == today:
            day.append(row)
        elif at.date() == tmr and at.hour < 13:
            morning.append(row)
    day.sort(key=lambda r: r["s"])
    morning.sort(key=lambda r: r["s"])
    return {"date": now.strftime("%a %b %-d").upper(), "events": day[:16], "allday": allday[:3], "tmr": morning[:4]}


def build_agenda(events: list, reminders: list, attention: list) -> list:
    now = _now()
    today = now.date()
    rows = []
    for text in attention:
        rows.append({"k": "attn", "t": "!", "title": text})
    items = []
    for e in events:
        s, en = datetime.fromisoformat(e["start"]), datetime.fromisoformat(e["end"])
        if e["all"]:
            if s.date() <= today < en.date():
                items.append((now.replace(hour=0, minute=0), {"k": "event", "t": "ALL", "title": e["title"]}))
            continue
        if en <= now:
            continue
        live = s <= now
        if s.date() > today + timedelta(days=1):
            continue
        day = _day_prefix(s, today)
        items.append((s, {"k": "event", "t": day + _clock(s), "title": e["title"], "now": live, "tmr": s.date() != today,
                          "s": s.isoformat(), "e": en.isoformat()}))
    for r in reminders:
        at = datetime.fromisoformat(r["at"])
        day = _day_prefix(at, today)                # reminders reach 3 days out: "SAT 9:00A", not "TMR"
        items.append((at, {"k": "remind", "t": day + _clock(at), "title": r["title"], "tmr": at.date() != today,
                           "s": at.isoformat()}))
    items.sort(key=lambda x: x[0])
    today_items = [i for _, i in items if not i.get("tmr")]
    tmr_items = [i for _, i in items if i.get("tmr")]
    rows += today_items
    shown_tmr = max(0, 6 - len(rows))
    rows += tmr_items[:shown_tmr]
    if not any(r["k"] != "attn" for r in rows):
        rows.append({"k": "none", "t": "", "title": "NOTHING ELSE TODAY"})
    # rows past the small panel's old cut are flagged "x": only the enlarged TODAY view draws them
    small, extra = rows[:9], rows[9:] + tmr_items[shown_tmr:]
    return small + [dict(r, x=1) for r in extra][:20]
