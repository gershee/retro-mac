#!/usr/bin/env python3
"""Offline checks for the text side of the speech pipeline (no audio, no server)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import server as s  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


check("segments + carry-forward emotion",
      s.speech_segments("[happy] Good news! The build passed. [concerned] One test is flaky."),
      [("happy", "Good news!"), ("happy", "The build passed."), ("concerned", "One test is flaky.")])
check("unknown tag dropped, never spoken",
      s.speech_segments("[giggles] Hello there. [THINKING] Let me see."),
      [(None, "Hello there."), ("thinking", "Let me see.")])
check("tag-only sentence skipped", s.speech_segments("[happy] . Done."), [("happy", "Done.")])
check("markdown link untouched by tag regex", s.strip_tags("see [docs](http://x) now"), "see [docs](http://x) now")
long = ("I checked the calendar, the weather, the train times, and the reminders you set last week, "
        "and everything lines up for the trip on Friday morning without any conflicts at all.")
parts = s.speech_segments(long)
check("run-on sentence split at commas", all(len(p) <= s.MAX_CHUNK_CHARS for _, p in parts) and len(parts) >= 2, True)
check("run-on keeps all words", " ".join(p for _, p in parts), long)

sp, card = s.derive_card_and_speech("[happy] Here's your day:\n- [thinking] 9am standup\n- Lunch with Felipe\n- [curious] Gym")
check("list card has no tags", card, {"type": "list", "title": "HERE'S YOUR DAY", "items": ["9am standup", "Lunch with Felipe", "Gym"]})
check("list speech keeps tag for emotion", s.speech_segments(sp)[0], ("happy", "Here's your day: The details are on screen."))
sp, card = s.derive_card_and_speech("[happy] Weather now:\nTemp: 51F\nWind: 8 mph\nRain: none")
check("rows card from tagged lines", card and [r["k"] for r in card["rows"]], ["Temp", "Wind", "Rain"])
sp, card = s.derive_card_and_speech("[surprised] " + "word " * 100)
check("summary card body untagged", card and "[" not in card["body"], True)
check("progress text trimmed", s.progress_text("Checking your calendar now. Then the weather. Then more. And more."),
      "Checking your calendar now. Then the weather.")
check("progress drops code", s.progress_text("Running this:\n```\nls -la\n```\nOne sec."), "Running this: One sec.")
check("norm sentence", s.norm_sentence("[happy] Checking   your Calendar!"), "checking your calendar")
said = {s.norm_sentence("Found it."), s.norm_sentence("Now checking traffic.")}
sp, _ = s.derive_card_and_speech("Found it. Now checking traffic. [happy] Free until three. [concerned] Bridge is slow. "
                                 "[giggle] Text him?", said)
check("narrated sentences skipped before the 3-sentence cap", s.speech_segments(sp),
      [("happy", "Free until three."), ("concerned", "Bridge is slow."), ("concerned", "Text him?")])
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
