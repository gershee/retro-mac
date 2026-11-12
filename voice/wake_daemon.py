"""Retro Mac wake daemon.

Listens on the built-in mic for the wake word (sherpa-onnx keyword spotter, same model Hermes ships),
then (1) tells the display "listening" and (2) presses the voice-record key in the Hermes voice
listener (tmux session hermes-voice, Ctrl-B) so Hermes captures, transcribes and answers your request.

Why not Hermes's own wake listener: on this Mac it reports "listening" but never fires on a real
voice (it opens the mic at 44.1 kHz and resamples); this direct 16 kHz capture was verified live.

Run with Hermes's python (it imports Hermes's bootstrap + sherpa model helper):
    HERMES_AGENT_DIR=~/.hermes/hermes-agent  <hermes python> voice/wake_daemon.py
or with any python that has sherpa-onnx, sounddevice and numpy, pointing at the KWS model from
scripts/fetch-models.sh:  RETRO_MAC_KWS_MODEL=models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
Env/args: --phrases "alfred,hey alfred"  --sens 0.35  --cooldown 8
"""
import argparse, collections, json, os, subprocess, sys, time, threading, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DATA = Path(os.environ.get("RETRO_MAC_DATA") or REPO / "data")
HERMES_HOME = os.path.expanduser(os.environ.get("HERMES_HOME") or "~/.hermes")
os.environ.setdefault("HERMES_HOME", HERMES_HOME)
_agent_dir = os.path.expanduser(os.environ.get("HERMES_AGENT_DIR") or os.path.join(HERMES_HOME, "hermes-agent"))
if os.path.isdir(_agent_dir):
    sys.path.insert(0, _agent_dir)
try:
    import hermes_bootstrap  # noqa: F401,E402
except ImportError:
    pass
import numpy as np  # noqa: E402
import sherpa_onnx  # noqa: E402
import sounddevice as sd  # noqa: E402
from sherpa_onnx import text2token  # noqa: E402


def _ensure_sherpa_model():
    """The KWS model: $RETRO_MAC_KWS_MODEL, else models/ (scripts/fetch-models.sh), else Hermes's own copy."""
    for p in (os.environ.get("RETRO_MAC_KWS_MODEL"), REPO / "models" / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"):
        if p and (Path(p) / "tokens.txt").exists():
            return Path(p)
    from tools.wake_word_engines import _ensure_sherpa_model as hermes_model  # noqa: E402
    return hermes_model()

ap = argparse.ArgumentParser()
ap.add_argument("--phrases", default="alfred,hey alf,alf,hey alfred")
ap.add_argument("--sens", type=float, default=0.35)
ap.add_argument("--cooldown", type=float, default=8.0)
ap.add_argument("--base", default=os.environ.get("RETRO_MAC_BASE", "http://127.0.0.1:8787"))
ap.add_argument("--followup-window", type=float, default=150.0, help="a reply counts as part of a voice conversation if it finishes within this many seconds of the last wake/follow-up (covers slow agent turns)")
ap.add_argument("--max-followups", type=int, default=3)
ap.add_argument("--arm-followup", type=float, default=3.0, help="after a spoken reply the mic stays open only this long waiting for you to START talking; silence closes it")
ap.add_argument("--arm-wake", type=float, default=5.0, help="same, after the wake word itself")
ap.add_argument("--speech-rms", type=float, default=400.0, help="mic block level (int16 rms) that counts as someone talking; room noise is ~20")
ap.add_argument("--level-hz", type=float, default=8.0, help="mic level updates per second sent to the kiosk banner while listening")
ap.add_argument("--silence-rms", type=float, default=200.0, help="Hermes voice.silence_threshold (rms); quieter than this counts toward the end-of-speech pause")
ap.add_argument("--floor-rms", type=float, default=150.0, help="gate: discard a fire if the mic block peak in the 1 s before it was below this (room noise ~20, speech 400+); 0 = off")
ap.add_argument("--short-floor-rms", type=float, default=250.0, help="gate: same, stricter floor for the short nickname phrases (ALF / HEY_ALF)")
ap.add_argument("--after-speech-gap", type=float, default=3.0, help="gate: discard a fire within this many seconds after the face finished speaking (its own voice / room echo); 0 = off")
ap.add_argument("--nospeech-cooldown", type=float, default=20.0, help="gate: after a wake whose mic window closed with no speech, ignore fires for this long so noise bursts cannot chain; 0 = off")
ap.add_argument("--junk-cooldown", type=float, default=20.0, help="gate: same, after the server drops a junk transcript ([BLANK_AUDIO] ...)")
ap.add_argument("--speech-blocks", type=int, default=2, help="after a wake, speech counts only after this many consecutive loud 80 ms mic blocks (one door slam = 1 block)")
ap.add_argument("--log", default=str(DATA / "logs" / "wake.log"))
ap.add_argument("--no-tmux", action="store_true", help="never touch the tmux voice session (tests)")
a = ap.parse_args()

TMUX = __import__("shutil").which("tmux") or "/usr/local/bin/tmux"
SESSION = os.environ.get("RETRO_MAC_VOICE_SESSION", "hermes-voice")
LOG = os.path.expanduser(a.log)
os.makedirs(os.path.dirname(LOG), exist_ok=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wake_gate import gate as wake_gate  # noqa: E402


def log(m):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {m}\n")


def post(path, body):
    try:
        req = urllib.request.Request(a.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=2).read() or b"{}")
    except Exception:
        return None


def tmux_key():
    """Press Ctrl-B (voice record toggle) in the Hermes voice listener; no-op with --no-tmux (tests)."""
    if not a.no_tmux:
        subprocess.run([TMUX, "send-keys", "-t", SESSION, "C-b"], capture_output=True, timeout=3)


def recording() -> bool:
    if a.no_tmux:
        return False
    try:
        out = subprocess.run([TMUX, "capture-pane", "-p", "-t", SESSION], capture_output=True, text=True, timeout=3).stdout
        return "● REC" in "\n".join(out.splitlines()[-6:])
    except Exception:
        return False


d = _ensure_sherpa_model()
PH = [p.strip().upper() for p in a.phrases.split(",") if p.strip()]
tok = text2token(PH, tokens=str(d / "tokens.txt"), tokens_type="bpe", bpe_model=str(d / "bpe.model"))
kw = str(DATA / "kws.txt")
os.makedirs(os.path.dirname(kw), exist_ok=True)
open(kw, "w").write("".join(" ".join(t) + f" @{p.replace(' ', '_')}\n" for t, p in zip(tok, PH)))


def mf(p):
    return str(sorted(d.glob(f"{p}-*[!8].onnx"))[0])


spotter = sherpa_onnx.KeywordSpotter(tokens=str(d / "tokens.txt"), encoder=mf("encoder"), decoder=mf("decoder"),
                                     joiner=mf("joiner"), keywords_file=kw,
                                     keywords_threshold=0.05 + 0.4 * a.sens, num_threads=1)
stream = spotter.create_stream()
state = {"last": 0.0, "fires": 0}
quiet = {"until": 0.0, "junk_seen": time.time()}   # fires ignored until this time (cooldown after no-speech / junk)
recent = collections.deque(maxlen=64)               # (time, block rms) of the last few seconds of mic
lv = {"max": 0.0, "rms": 0.0, "loud_at": 0.0, "spoke": False}
listen = {"on": False, "t0": 0.0}   # kiosk banner wants mic levels
mute = {"until": 0.0, "was": False, "speaking": False, "followups": 0}
arm = {"open": False, "t0": 0.0, "secs": 0.0, "heard": False, "loud_run": 0, "ptt": False}
ptt = {"on": False, "req": None}      # push-to-talk mode (server /health `ptt`): the wake word is ignored; Space starts the mic
SETTINGS = str(DATA / "settings.json")


def ptt_now() -> bool:
    """Fresh check at every fire: server /health `ptt`, else the persisted settings.json (server down)."""
    try:
        return bool(json.loads(urllib.request.urlopen(a.base + "/health", timeout=1.5).read()).get("ptt"))
    except Exception:
        pass
    try:
        return bool(json.load(open(SETTINGS)).get("ptt")) if a.base.rstrip("/").endswith(":" + os.environ.get("RETRO_MAC_PORT", "8787")) else False
    except Exception:
        return False


ptt["on"] = ptt_now()                  # know the mode BEFORE the first mic open: in push-to-talk the mic is not opened at start
mic = {"stream": None, "idle_since": None, "opened_at": 0.0}   # the CoreAudio input: open always in wake mode, only during a Space-tap window in ptt mode


def mic_wanted() -> bool:
    """Wake mode: always (spotter). Push-to-talk: only while a turn's mic window is live (no-speech timer, or the
    banner is still LISTENING/HEARD and wants the level meter / end-of-speech)."""
    return (not ptt["on"]) or arm["open"] or listen["on"]


def arm_listen(secs, followup=False, ptt_turn=False):
    arm.update(open=True, t0=time.time(), secs=secs, heard=False, loud_run=0, followup=followup, ptt=ptt_turn)


def start_levels():
    lv.update(spoke=False, loud_at=time.time())
    listen.update(on=True, t0=time.time())


def level_poster():
    """While the kiosk shows LISTENING, send it the mic level (~8 Hz) plus how long it has been quiet since you
    last spoke (Hermes stops recording after voice.silence_duration of quiet). Stops when the server leaves
    heard/listening; costs nothing otherwise."""
    import math
    gap = 1.0 / max(1.0, a.level_hz)
    while True:
        if not listen["on"]:
            time.sleep(0.2)
            continue
        rms = lv["rms"]
        db = 20 * math.log10(max(rms, 1.0))
        l = max(0.0, min(1.0, (db - 26.0) / 44.0))      # ~room noise (rms 20) -> 0, loud voice (rms ~3000) -> 1
        r = post("/level", {"l": round(l, 3), "s": round(time.time() - lv["loud_at"], 2), "sp": lv["spoke"]})
        if (r is not None and r.get("state") not in ("heard", "listening")) or time.time() - listen["t0"] > 150:
            listen["on"] = False
        time.sleep(gap)


threading.Thread(target=level_poster, daemon=True).start()


def mute_poller():
    """The face speaks through the same speakers the mic hears (and says "Alfred"): stay deaf while it talks."""
    while True:
        try:
            h = json.loads(urllib.request.urlopen(a.base + "/health", timeout=2).read())
            sp = h.get("speaking_for", 0)
            if sp > 0:
                mute["until"] = time.time() + sp
                mute["speaking"] = True
            elif mute["speaking"]:
                mute["speaking"] = False
                # reply finished: keep the conversation going without repeating the wake word. Only after a real
                # reply to a voice ask (server: followup_ok), never after a progress line ("On it.") or a worker.
                if (h.get("followup_ok", True) and not ptt["on"] and time.time() - state["last"] < a.followup_window
                        and mute["followups"] < a.max_followups and not recording()):
                    mute["followups"] += 1
                    time.sleep(0.6)                       # let the room go quiet after the last syllable
                    post("/arm", {"secs": 600})
                    post("/voice_state", {"state": "listening", "followup": True, "window": a.arm_followup})
                    start_levels()
                    post("/activity", {"agent": "alfred", "status": "listening", "label": "LISTENING"})
                    tmux_key()
                    arm_listen(a.arm_followup, followup=True)
                    state["last"] = time.time()
                    log(f"FOLLOWUP #{mute['followups']} -> mic open for {a.arm_followup:.0f}s")
            vs = (h.get("voice") or {}).get("state")
            now_ptt = bool(h.get("ptt"))
            if now_ptt != ptt["on"]:
                ptt["on"] = now_ptt
                log("push-to-talk mode " + ("ON: wake word ignored (spotter paused), Space starts the mic" if now_ptt else "OFF: wake word live again"))
            pr = h.get("ptt_req") or {}
            if ptt["req"] is None:
                ptt["req"] = (pr.get("id"), pr.get("at"))                 # first poll: do not replay an old request
            elif (pr.get("id"), pr.get("at")) != ptt["req"]:
                ptt["req"] = (pr.get("id"), pr.get("at"))
                if time.time() - float(pr.get("at") or 0) < 5:
                    if pr.get("kind") == "stop":                             # Space again: Hermes is transcribing, stop the no-speech timer
                        arm["open"] = False
                        log("PTT stop tap -> recording ended by hand")
                    else:
                        mute["followups"] = 0
                        state["last"] = time.time()
                        start_levels()
                        arm_listen(float(pr.get("window") or 8.0), ptt_turn=True)
                        log(f"PTT start -> mic window {float(pr.get('window') or 8.0):.0f}s")
            ja = float((h.get("junk") or {}).get("at") or 0.0)
            if ja > quiet["junk_seen"]:                  # server dropped a junk transcript: the wake behind it was noise
                quiet["junk_seen"] = ja
                if a.junk_cooldown > 0:
                    quiet["until"] = max(quiet["until"], ja + a.junk_cooldown)
                    log(f"junk transcript dropped by the server -> wake fires ignored for {a.junk_cooldown:.0f}s")
            if vs in ("heard", "listening") and not listen["on"]:
                start_levels()                            # e.g. record key pressed by hand
        except Exception:
            pass
        # nobody started talking in time -> close the mic again (toggle record off, nothing is sent)
        if arm["open"] and not arm["heard"] and time.time() - arm["t0"] > arm["secs"]:
            arm["open"] = False
            # tell the banner first, so the REC-off the server sees next is not mistaken for a recording to transcribe
            if arm.get("followup"):
                post("/voice_state", {"state": "idle", "note": ""})          # silence after a reply = conversation over
            elif arm.get("ptt"):
                post("/voice_state", {"state": "error", "note": "NO SPEECH HEARD. TAP SPACE TO TRY AGAIN"})
            else:
                post("/voice_state", {"state": "error", "note": "I HEARD MY NAME, THEN NOTHING"})
            if recording():
                tmux_key()
            post("/activity", {"agent": "alfred", "status": "idle", "label": ""})
            post("/disarm", {})                        # nobody answered: back to silent
            if not arm.get("followup") and not arm.get("ptt") and a.nospeech_cooldown > 0:
                quiet["until"] = max(quiet["until"], time.time() + a.nospeech_cooldown)   # noise bursts must not chain
            log("mic closed: no speech within the listening window" + (" (follow-up)" if arm.get("followup") else
                " (push-to-talk)" if arm.get("ptt") else f" -> wake fires ignored for {a.nospeech_cooldown:.0f}s"))
        elif arm["open"] and arm["heard"]:
            arm["open"] = False                      # someone is talking: Hermes's own end-of-speech detection takes over
        time.sleep(0.3)


threading.Thread(target=mute_poller, daemon=True).start()


def on_wake():
    now = time.time()
    if now - state["last"] < a.cooldown:
        return
    state["last"] = now
    state["fires"] += 1
    mute["followups"] = 0
    post("/arm", {"secs": 600})            # spoken replies allowed from now on (he just talked to us)
    post("/voice_state", {"state": "heard", "window": a.arm_wake})   # kiosk: flash + blip + HEARD YOU, at once
    start_levels()
    arm_listen(a.arm_wake)
    post("/activity", {"agent": "alfred", "status": "listening", "label": "LISTENING"})
    if not recording():
        tmux_key()
    log(f"WAKE #{state['fires']} -> record key sent" + (" (no-tmux)" if a.no_tmux else ""))


def handle_fire(r, pre_max, pre_mean):
    """A keyword-spotter fire: log the mic level under it, then gate it (cooldown / face just spoke / too quiet)."""
    now = time.time()
    if ptt["on"] or ptt_now():
        ptt["on"] = True
        log(f"heard <{r}> level 1s before: peak {pre_max:.0f} mean {pre_mean:.0f} -> IGNORED: push-to-talk mode (tap Space)")
        return False
    why = wake_gate(now=now, phrase=str(r), pre_max=pre_max, quiet_until=quiet["until"], speech_ended=mute["until"],
                    floor=a.floor_rms, short_floor=a.short_floor_rms, after_speech_gap=a.after_speech_gap)
    log(f"heard <{r}> level 1s before: peak {pre_max:.0f} mean {pre_mean:.0f}" + (f" -> REJECTED: {why}" if why else " -> ok"))
    if why:
        return False
    on_wake()
    return True


def pre_fire_levels(now=None):
    now = now or time.time()
    xs = [v for t, v in list(recent) if now - t <= 1.0]
    return (max(xs), sum(xs) / len(xs)) if xs else (0.0, 0.0)


def cb(indata, frames, ti, status):
    global stream
    x = indata[:, 0].astype(np.float32) / 32768.0
    if time.time() < mute["until"]:
        mute["was"] = True
        lv["max"] = max(lv["max"], float(np.abs(x).max()) * 32768)
        return
    if mute["was"]:                       # coming out of mute: drop any speaker audio still buffered
        mute["was"] = False; stream = spotter.create_stream(); recent.clear()
    rms = float(np.sqrt(np.mean((x * 32768.0) ** 2)))
    lv["rms"] = rms
    recent.append((time.time(), rms))
    if listen["on"] and rms > a.silence_rms and time.time() - listen["t0"] > 0.7:
        lv["loud_at"] = time.time()
        if rms > a.speech_rms:
            lv["spoke"] = True
    if arm["open"] and not arm["heard"] and time.time() - arm["t0"] > 0.7:   # 0.7s: ignore the wake word's own tail
        arm["loud_run"] = arm["loud_run"] + 1 if rms > a.speech_rms else 0     # consecutive loud blocks: a click is not speech
        if arm["loud_run"] >= max(1, a.speech_blocks):
            arm["heard"] = True
    if ptt["on"]:                         # push-to-talk: no wake word, so skip the spotter (saves CPU); the meter above keeps running
        ptt["was"] = True
        lv["max"] = max(lv["max"], float(np.abs(x).max()) * 32768)
        return
    if ptt.get("was"):
        ptt["was"] = False; stream = spotter.create_stream()
    stream.accept_waveform(16000, x)
    while spotter.is_ready(stream):
        spotter.decode_stream(stream)
        r = spotter.get_result(stream)
        if r:
            spotter.reset_stream(stream)
            pm, pmean = pre_fire_levels()
            threading.Thread(target=handle_fire, args=(r, pm, pmean), daemon=True).start()
    lv["max"] = max(lv["max"], float(np.abs(x).max()) * 32768)


def _selftest_gate():
    """WAKE_SELFTEST=gate: fake fires through handle_fire (no mic needed, no tmux with --no-tmux)."""
    time.sleep(2)
    log("selftest gate: 1) loud ALFRED")
    r1 = handle_fire("ALFRED", 900.0, 300.0)
    time.sleep(a.arm_wake + 3)             # nobody talks: mic window closes, no-speech cooldown starts
    log(f"selftest gate: quiet_until in {quiet['until'] - time.time():.0f}s")
    state["last"] = 0.0                    # bypass the plain 8 s cooldown so only the new gates decide
    r2 = handle_fire("ALFRED", 900.0, 300.0)
    quiet["until"] = 0.0
    r3 = handle_fire("ALFRED", 40.0, 20.0)
    r4 = handle_fire("ALF", 200.0, 90.0)
    mute["until"] = time.time() - 1.0
    r5 = handle_fire("ALFRED", 900.0, 300.0)
    mute["until"] = 0.0
    state["last"] = 0.0
    r6 = handle_fire("ALF", 900.0, 300.0)
    log(f"selftest gate results: loud={r1} after_nospeech={r2} quiet={r3} short_quiet={r4} after_speech={r5} short_loud={r6}")
    ok = (r1, r2, r3, r4, r5, r6) == (True, False, False, False, False, True)
    log("selftest gate " + ("PASS" if ok else "FAIL")); time.sleep(a.arm_wake + 3); os._exit(0 if ok else 1)


if os.environ.get("WAKE_SELFTEST") == "gate":    # fake fires through the gate (run with --no-tmux --base :8792 --log <tmp> --speech-rms 999999)
    threading.Thread(target=_selftest_gate, daemon=True).start()
elif os.environ.get("WAKE_SELFTEST"):          # simulate a wake with nobody talking: the mic should close by itself
    def _st():
        time.sleep(3); on_wake(); time.sleep(a.arm_wake + 4); log("selftest done"); os._exit(0)
    threading.Thread(target=_st, daemon=True).start()
def mic_open():
    global stream
    stream = spotter.create_stream(); recent.clear(); ptt["was"] = False; mute["was"] = False
    lv.update(max=0.0, rms=0.0)
    s = sd.InputStream(samplerate=16000, channels=1, dtype="int16", blocksize=1280, callback=cb)
    s.start()
    mic.update(stream=s, idle_since=None, opened_at=time.time(), next_log=time.time() + 20)
    log("mic opened (ptt window)" if ptt["on"] else "mic opened (wake mode: spotter live)")


def mic_close(why):
    s, mic["stream"] = mic["stream"], None
    try:
        if s is not None:
            s.stop(); s.close()                       # releases the CoreAudio input unit
    finally:
        lv.update(max=0.0, rms=0.0); recent.clear(); arm["loud_run"] = 0
        log(f"mic released ({why})")


log(f"start phrases={PH} sens={a.sens} cooldown={a.cooldown} ptt={'ON' if ptt['on'] else 'off'}")
if ptt["on"]:
    log("mic released (ptt idle)")                    # push-to-talk at start: nothing listens until a Space tap
while True:
    try:
        want = mic_wanted()
        if want and mic["stream"] is None:
            mic_open()
        elif not want and mic["stream"] is not None:
            mic["idle_since"] = mic["idle_since"] or time.time()
            if time.time() - mic["idle_since"] >= 0.5:      # window over (speech sent / no-speech timeout / stop / mode change)
                mic_close("ptt idle")
        else:
            mic["idle_since"] = None
        if mic["stream"] is not None and time.time() >= mic["next_log"]:
            log(f"mic peak last 20s: {lv['max']:.0f}"); lv["max"] = 0.0; mic["next_log"] = time.time() + 20
        time.sleep(0.1)
    except Exception as e:  # mic unavailable / device change: retry
        log(f"audio error: {e!r}; retrying in 5s")
        try:
            if mic["stream"] is not None:
                mic["stream"].close()
        except Exception:
            pass
        mic["stream"] = None
        time.sleep(5)
