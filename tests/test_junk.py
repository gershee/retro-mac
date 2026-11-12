#!/usr/bin/env python3
"""Junk-transcript + wake-gate test. Silent, no model calls, never touches the live kiosk / tmux / speakers.

  A. junk filter (hermes-plugin/retro_mac_face/junk.py) on junk and real strings
  B. wake gate (voice/wake_gate.py) decisions
  C. spare-port test server (testsrv.py, default 8792): /voice_turn junk -> kind junk, quiet DIDN'T CATCH THAT for ~3 s,
     mic window released, nothing spoken; real turns / cancel / Telegram / running turn unaffected
  D. the real hook module pointed at that server: pre_llm_call blocks junk ({"action":"block"}), passes real speech
  venv/bin/python tests/test_junk.py [port]
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("RETRO_MAC_PORT", "8792"))
BASE = f"http://127.0.0.1:{PORT}"
os.environ["RETRO_MAC_BASE"] = BASE          # the hook reads this at import
os.environ["HERMES_HOME"] = str(Path.home() / ".hermes")   # default home = agent alfred (the voice agent), whatever profile runs this
FAILS = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ---------------------------------------------------------------- A: filter
junk = load("junk_t", ROOT / "hermes-plugin/retro_mac_face/junk.py")
JUNK = ["[BLANK_AUDIO]", "[SOUND] [BLANK_AUDIO]", "(inaudible) (inaudible)", "[ ]", "[Music]", "(music)", "(silence)",
        "[silence]", "[ Silence ]", "...", "", "   ", "( )", "- . -", "you", "You.", "YOU", "Thanks for watching",
        "thanks for watching!", "Thank you for watching.", "bye", "Bye.", "bye bye", "um", "uh, um", "hmm", "*sigh*",
        "[MUSIC PLAYING]", "♪", "[blank_audio] [BLANK_AUDIO]", "(inaudible)", "[ Inaudible ]", "I", None,
        "(speaking in foreign language)", "(speaks foreign language)", "[foreign language]", "(foreign)",
        "(music playing)", "(upbeat music)", "(door closes)", "(coughs)", "(sighs)", "(laughs)", "(clears throat)",
        "(background noise)", "[typing]", "(silence)", "(static)", "*music*", "♪ la la la ♪", "♪♪", "♪ humming",
        "(speaking in a foreign language)", "(coughs) (sighs)", "[typing] *music* (static)", "(speaking in foreign language",
        "[clock ticking]", "(dog barking)", "  (Speaking in Foreign Language).  "]
REAL = ["what's on my calendar", "I'll try a lot on my team. I'll try a lot on my team.", "stop", "cancel that",
        "never mind", "yes", "no", "thank you", "thanks", "what time is it", "you are late", "bye alfred",
        "[IMPORTANT: Background process proc_1 finished with exit code 0 and a very long report follows here]",
        "turn off the lights", "hello", "ok", "play music", "add milk (the oat kind) to my list",
        "(laughs) what's on my calendar", "remind me at five [pm] to call mom",
        "what does (speaking in foreign language) mean", "call mom *please*", "I said foreign language"]
bad = [t for t in JUNK if not junk.is_junk(t)]
check("A every junk string is junk", not bad, bad)
bad = [t for t in REAL if junk.is_junk(t)]
check("A no real string is junk", not bad, bad)

# ---------------------------------------------------------------- B: wake gate
g = load("gate_t", ROOT / "voice/wake_gate.py").gate
base = dict(now=1000.0, phrase="ALFRED", pre_max=900.0, quiet_until=0.0, speech_ended=0.0,
            floor=150.0, short_floor=250.0, after_speech_gap=3.0)
check("B loud real wake passes", g(**base) is None)
check("B quiet fire rejected", g(**{**base, "pre_max": 60.0}) is not None)
check("B ALF needs the higher floor", g(**{**base, "phrase": "ALF", "pre_max": 200.0}) is not None
      and g(**{**base, "phrase": "ALFRED", "pre_max": 200.0}) is None)
check("B HEY_ALF counts as short", g(**{**base, "phrase": "HEY_ALF", "pre_max": 200.0}) is not None)
check("B 2 s after the face spoke rejected, 4 s ok", g(**{**base, "speech_ended": 998.0}) is not None
      and g(**{**base, "speech_ended": 996.0}) is None)
check("B cooldown rejects, expired passes", g(**{**base, "quiet_until": 1010.0}) is not None
      and g(**{**base, "quiet_until": 990.0}) is None)
check("B gates off with 0", g(**{**base, "pre_max": 0.0, "floor": 0.0, "short_floor": 0.0, "after_speech_gap": 0.0,
                                  "speech_ended": 999.9}) is None)


# ---------------------------------------------------------------- C: server
def call(path, body=None):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read() or b"{}")


def vs():
    return call("/voice_state")


def turn(text, sid="s1", platform="tui", marker=True):
    return call("/voice_turn", {"agent": "alfred", "session_id": sid, "platform": platform, "text": text, "marker": marker})


def spoken_lines(path):
    return [ln for ln in Path(path).read_text().splitlines() if "speech #" in ln or "POST /speak" in ln]


logf = ROOT / "data" / "logs" / "kiosk2-junk-test.log"
logf.parent.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen([sys.executable, str(ROOT / "tests/testsrv.py"), str(ROOT / "server/server.py"), str(PORT)],
                       stdout=open(logf, "w"), stderr=subprocess.STDOUT, cwd=str(ROOT))
try:
    for _ in range(80):
        try:
            call("/health")
            break
        except Exception:
            time.sleep(0.5)
    else:
        sys.exit("test server did not start")

    call("/arm", {"secs": 600})
    call("/voice_state", {"state": "transcribing"})
    r = turn("[SOUND] [BLANK_AUDIO]")
    check("C junk -> kind junk", r.get("kind") == "junk", r)
    v, h = vs(), call("/health")
    check("C banner = error, note NO SPEECH HEARD", v["state"] == "error" and v["note"] == "NO SPEECH HEARD", (v["state"], v["note"]))
    check("C no turn registered", v["turn"] is None, v["turn"])
    check("C mic window released (not armed)", not v["armed"] and h["armed_for"] == 0.0, (v["armed"], h["armed_for"]))
    check("C no follow-up mic", h["followup_ok"] is False)
    check("C junk counted", h["junk"]["count"] == 1 and h["junk"]["at"] > 0, h["junk"])
    time.sleep(3.6)
    v = vs()
    check("C banner back to idle after ~3 s (not the 6 s error hold)", v["state"] == "idle", v["state"])

    for t in ("(inaudible) (inaudible)", "[ ]", "you", "Thanks for watching"):
        check(f"C {t!r} -> junk", turn(t).get("kind") == "junk")
    check("C Telegram junk is not a voice turn", turn("[BLANK_AUDIO]", platform="telegram").get("kind") == "none")
    check("C junk without the voice marker is not touched", turn("...", marker=False).get("kind") == "none")

    call("/arm", {"secs": 600})
    r = turn("what's on my calendar", sid="s2")
    check("C real speech -> voice turn", r.get("kind") == "voice", r)
    r = turn("[BLANK_AUDIO]", sid="s2")
    v = vs()
    check("C junk during a running turn leaves it alone", r.get("kind") == "junk" and v["turn"] is not None and v["state"] == "working",
          (r, v["state"], v["turn"]))
    call("/voice_state", {"state": "done", "session_id": "s2"})
    time.sleep(0.3)
    r = turn("I'll try a lot on my team", sid="s3")
    check("C garbled-but-real speech still goes to the model", r.get("kind") == "voice", r)
    call("/voice_state", {"state": "done", "session_id": "s3"})
    r = turn("never mind", sid="s4")
    check("C cancel phrase still cancels", r.get("kind") == "cancel", r)

    # ------------------------------------------------------------ D: the real hook
    hook = load("hook_t", ROOT / "hermes-plugin/retro_mac_face/__init__.py")
    check("D hook loaded the junk filter", hook._is_junk is not None)
    hook._on_pre_transcription(source="voice_mode", file_path="/dev/null")
    out = hook._on_pre_llm_call(session_id="h1", platform="tui", user_message="[SOUND] [BLANK_AUDIO]")
    check("D junk voice turn is blocked before the model", isinstance(out, dict) and out.get("action") == "block"
          and out.get("message") == "[SILENT]", out)
    check("D voice mark consumed", hook._voice_mark["t"] == 0.0)
    time.sleep(0.8)
    check("D server saw it (junk count 7+)", call("/health")["junk"]["count"] >= 7, call("/health")["junk"])
    call("/arm", {"secs": 600})
    hook._on_pre_transcription(source="voice_mode", file_path="/dev/null")
    out = hook._on_pre_llm_call(session_id="h2", platform="tui", user_message="what's on my calendar")
    check("D real voice turn gets the rules, not a block", isinstance(out, dict) and "context" in out
          and "[SILENT]" in out["context"], out)
    hook._on_post_llm_call(session_id="h2", platform="tui", user_message="what's on my calendar", assistant_response="[SILENT]")
    out = hook._on_pre_llm_call(session_id="h3", platform="tui", user_message="[BLANK_AUDIO]")   # no fresh marker
    check("D junk typed in the TUI (no voice marker) is left to the server (none -> no block)",
          not (isinstance(out, dict) and out.get("action") == "block"), out)
    hook._on_pre_transcription(source="voice_mode", file_path="/dev/null")
    out = hook._on_pre_llm_call(session_id="h4", platform="telegram", user_message="[BLANK_AUDIO]")
    check("D Telegram turn never blocked", not (isinstance(out, dict) and out.get("action") == "block"), out)
    # the real 2026-11-06 08:10 case: platform "local", PTT transcript, with and without the pre_transcription marker
    hook._on_pre_transcription(source="voice_mode", file_path="/dev/null")
    out = hook._on_pre_llm_call(session_id="h5", platform="local", user_message="(speaking in foreign language)")
    check("D platform=local '(speaking in foreign language)' blocked (marker)", isinstance(out, dict) and out.get("action") == "block", out)
    hook._voice_mark["t"] = 0.0
    time.sleep(3.6)                       # let the junk banner hold (error -> idle) expire before the next voice_state
    call("/arm", {"secs": 600})
    call("/voice_state", {"state": "transcribing"})
    out = hook._on_pre_llm_call(session_id="h6", platform="local", user_message="(speaking in foreign language)")
    check("D platform=local junk blocked via server while transcribing (no marker)", isinstance(out, dict) and out.get("action") == "block", out)
    time.sleep(0.8)
    check("D nothing was spoken during the whole test", not spoken_lines(logf), spoken_lines(logf)[:3])
finally:
    srv.terminate()

print("\nALL PASS" if not FAILS else f"\nFAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
