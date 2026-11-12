#!/usr/bin/env python3
"""HOUSE window probes, offline: the pmset mic-holder parser (fixture text) and house_snapshot's MIC HELD alert.
No server, no real pmset/launchctl calls.

  venv/bin/python tests/test_house.py
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
sys.argv = sys.argv[:1]
import micprobe  # noqa: E402
import server as s  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


held = (HERE / "fixtures" / "pmset_mic_held.txt").read_text()
check("parser: mic input held by pid 12345 (output assertion ignored)", micprobe.parse_assertions(held),
      [{"pid": 12345, "for": "02:13:10"}])
idle = "\n".join(ln for ln in held.splitlines() if "EngineInput" not in ln and "12345" not in ln)
check("parser: no input assertion -> nothing", micprobe.parse_assertions(idle), [])
check("parser: empty / garbage", micprobe.parse_assertions("") + micprobe.parse_assertions("pmset: not found"), [])
two = held + held.replace("12345", "777").replace("02:13:10", "00:01:00")
check("parser: two holders, deduped", [h["pid"] for h in micprobe.parse_assertions(two)], [12345, 777])

real_platform = micprobe.sys.platform
micprobe.sys.platform = "linux"
check("mic_holders: no-op on Linux", micprobe.mic_holders(), [])
micprobe.sys.platform = real_platform

# house_snapshot with fake probes (never runs pmset / launchctl here)
s._launchd = lambda: {"com.hermes.retro-mac-wake": "555"}
calls = []


def fake_holders(exclude=()):
    calls.append(tuple(exclude))
    return [h for h in [{"pid": 12345, "for": "02:13:10"}] if str(h["pid"]) not in map(str, exclude)]


s.micprobe.mic_holders = fake_holders
snap = s.house_snapshot(1, True, {}, True)
check("ptt idle + holder -> MIC HELD note", snap["mic"]["note"], "MIC HELD BY PID 12345")
check("ptt idle + holder -> alert", any(a.startswith("MIC HELD BY PID 12345") for a in snap["alerts"]), True)
check("ptt idle: nothing excluded", calls[-1], ())
snap = s.house_snapshot(1, True, {}, False)
check("voice busy -> no mic check, no alert", (snap["mic"]["note"], any("MIC HELD" in a for a in snap["alerts"])),
      ("MIC CLOSED (IDLE)", False))
snap = s.house_snapshot(1, False, {}, True)
check("wake word mode: wake daemon pid excluded", calls[-1], ("555",))
s.micprobe.mic_holders = lambda exclude=(): []
snap = s.house_snapshot(1, True, {}, True)
check("nobody holds it -> MIC CLOSED (IDLE)", snap["mic"]["note"], "MIC CLOSED (IDLE)")
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
