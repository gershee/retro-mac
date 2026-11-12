#!/usr/bin/env python3
"""Retro Mac display server.

Local only (127.0.0.1). Serves the face page, relays events to display clients
over WebSocket, and turns text into speech with Piper.

  GET  /            the face page
  GET  /ws          WebSocket for displays
  POST /speak       {agent, text, card?, voice?: voice|result|progress}
                    -> split into sentences, synthesize one at a time (worker thread), push each chunk as it is
                       ready ({stream:{id,seq,total,final}, emotion}) to displays that said caps:["stream"] in their
                       ws hello; older displays get the whole reply as one WAV (v0.4 behaviour).
                       voice=progress: mid-turn narration of the running voice turn ("Checking your calendar.")
                    [happy] [thinking] [surprised] [curious] [concerned] [sleepy] tags set the chunk's emotion and are
                    never spoken or shown on a card; unknown [tags] are dropped silently.
  POST /event       {agent, state, card?}  -> push a state/card event (no audio)
  POST /activity    {agent, status, label, session_id, caption?, step?: start|done, call_id?}  crew badge + the
                    voice turn's step checklist (banner)
  GET  /health      {ok, clients, voices, voice, tui, ...}
  GET/POST /voice_state   voice-interaction state machine (single source of truth for the kiosk banner)
  POST /voice_turn  {agent, session_id, platform, text, marker} -> {kind}   (plugin, start of every local turn)
  POST /level       {l, s, sp}             mic level while listening (wake daemon, ~8 Hz)
  POST /voice_pending {op: add|done|clear}  background jobs the user asked for by voice

Run:  python server/server.py [--demo]      (or ./start.sh --demo). Config: config.toml, see config.example.toml.
"""
import asyncio
import concurrent.futures
import hashlib
import os
import shutil
import base64
import io
import json
import logging
import logging.handlers
import re
import sys
import time
import wave
from pathlib import Path

from aiohttp import web, WSMsgType

import config  # noqa: E402  (also sets up data/ and reads config.toml)
import feeds  # noqa: E402
import micprobe  # noqa: E402

ROOT = config.ROOT
WEB = config.WEB
VOICES_DIR = config.VOICES_DIR
HOST, PORT = "127.0.0.1", config.PORT
DEMO = config.DEMO

import importlib.util as _ilu  # noqa: E402
_jspec = _ilu.spec_from_file_location("retro_mac_junk", config.PLUGIN_DIR / "junk.py")
_junk = _ilu.module_from_spec(_jspec)
_jspec.loader.exec_module(_junk)          # one junk filter for the hook and the server
is_junk = _junk.is_junk

# One distinct Piper voice per agent ([voices] in config.toml). Missing voice files are fine: the face then
# "beep-speaks" (a retro babble that still drives the lip sync). Run scripts/fetch-models.sh for real voices.
VOICE_FILES = {a: config.CFG["voices"][a] for a in ("alfred", "scout", "maker")}
AGENTS = tuple(VOICE_FILES)

MAX_SPOKEN_CHARS = 300
MAX_SPOKEN_SENTENCES = 3
SUMMARY_THRESHOLD = 380  # chars of cleaned text above which a summary card is shown

log = logging.getLogger("retro-mac")
voices = {}
clients = set()
synth_lock = asyncio.Lock()
state = {"agent": "alfred", "state": "idle", "card": None}
speak_until = {"t": 0.0}
armed = {"until": 0.0}   # voice is only allowed while the user has just spoken to us (wake word / Space); otherwise replies stay silent

THEMES = ("green", "amber", "paper", "mono", "cyan")
SETTINGS_FILE = config.DATA_DIR / "settings.json"
settings = {"theme": "green", "tone": 1.0, "ptt": False}  # tone: 0 = light (paper) .. 1 = dark (theme); ptt: push-to-talk mode (Space bar), wake word off
PTT_WINDOW = 8.0          # push-to-talk: the mic closes by itself if nobody starts talking within this many seconds
ptt_req = {"id": 0, "at": 0.0, "kind": "", "window": PTT_WINDOW}   # last Space request; the wake daemon (mic meter + no-speech timeout) follows it
ptt_seen = {"n": 0, "at": 0.0, "info": {}}   # debug breadcrumb: Space keydown reached the kiosk page (face.js), whether or not the server acted
ptt_dry = {"n": 0, "at": 0.0, "would": ""}   # /ptt?dry=1 records the decision without pressing tmux keys
dash = {"type": "dash", "weather": None, "agenda": [], "tz": config.TZ_NAME}   # tz: the kiosk draws clocks in it
_raw = {"events": [], "reminders": [], "weather_at": 0.0, "cal_at": 0.0}
refresh_now = asyncio.Event()


def load_settings():
    try:
        d = json.loads(SETTINGS_FILE.read_text())
        if d.get("theme") in THEMES:
            settings["theme"] = d["theme"]
        if isinstance(d.get("tone"), (int, float)):
            settings["tone"] = max(0.0, min(1.0, float(d["tone"])))
        if isinstance(d.get("ptt"), bool):
            settings["ptt"] = d["ptt"]
    except Exception:
        pass


def save_settings():
    SETTINGS_FILE.write_text(json.dumps(settings))


# ---------------------------------------------------------------- text helpers
LIST_RE = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])\s+(.*\S)\s*$")
KV_RE = re.compile(r"^\s*(?:[-*\u2022]\s*)?([A-Za-z][\w /&'.-]{1,28}?)\s*[:\u2014]\s+(.{1,60})\s*$")
MD_RE = re.compile(r"(\*\*|__|`|~~|^#+\s*|^>\s*)", re.M)
URL_RE = re.compile(r"https?://\S+")
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F300-\U0001F64F\uFE0F\u200d]"
)


def strip_md(s: str) -> str:
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = URL_RE.sub("", s)
    s = MD_RE.sub("", s)
    s = EMOJI_RE.sub("", s)
    return re.sub(r"[ \t]+", " ", s).strip()


def clean_for_speech(text: str, skip=None) -> str:
    """skip: normalized sentences already spoken (mid-turn narration); dropped before the sentence cap."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    flat = " ".join(strip_md(l) for l in text.splitlines() if strip_md(l))
    flat = re.sub(r"\s+", " ", flat).strip()
    sentences = re.split(r"(?<=[.!?])\s+", flat)
    if skip:
        sentences = [s for s in sentences if norm_sentence(s) not in skip]
    out = ""
    for s in sentences[:MAX_SPOKEN_SENTENCES]:
        if out and len(out) + len(s) > MAX_SPOKEN_CHARS:
            break
        out = f"{out} {s}".strip()
    if len(out) > MAX_SPOKEN_CHARS:
        out = out[:MAX_SPOKEN_CHARS].rsplit(" ", 1)[0] + "."
    return out


def derive_card_and_speech(text: str, skip=None):
    """Return (spoken_text, card_or_None) for a raw agent reply. Emotion [tags] stay in the spoken text (the
    speech pipeline turns them into per-chunk emotions) but never reach a card."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    lines = [l for l in text.splitlines()]
    plain = [strip_tags(l) for l in lines]
    items, intro = [], []
    for l, p in zip(lines, plain):
        m = LIST_RE.match(p)
        if m:
            items.append(strip_md(m.group(1)))
        elif not items and p.strip():
            intro.append(strip_md(l))

    if len(items) >= 3:
        head = strip_tags(intro[0] if intro else "").rstrip(":").strip()
        title = head.upper() if 0 < len(head) <= 22 else "DETAILS"
        card = {"type": "list", "title": title, "items": items[:8]}
        spoken = clean_for_speech(" ".join(intro), skip) if intro else ""
        spoken = (spoken + " " if spoken else "") + "The details are on screen."
        return spoken, card

    kvs = [KV_RE.match(p) for p in plain if p.strip()]
    kvs = [m for m in kvs if m]
    if len(kvs) >= 3:
        rows = [{"k": strip_md(m.group(1)), "v": strip_md(m.group(2))} for m in kvs[:8]]
        return clean_for_speech(text, skip), {"type": "rows", "title": "DETAILS", "rows": rows}

    cleaned = " ".join(strip_md(p) for p in plain if strip_md(p))
    if len(cleaned) > SUMMARY_THRESHOLD:
        body = cleaned if len(cleaned) <= 520 else cleaned[:520].rsplit(" ", 1)[0] + "..."
        return clean_for_speech(text, skip), {"type": "text", "title": "SUMMARY", "body": body}

    return clean_for_speech(text, skip), None


# ------------------------------------------------------------- emotion + sentences
# Voice turns may start sentences with a tone tag; it switches the face for that chunk. Only these are honoured;
# any other single-word [tag] is removed silently (never spoken, never on a card).
EMOTIONS = ("happy", "thinking", "surprised", "curious", "concerned", "sleepy")
TAG_RE = re.compile(r"\[\s*([A-Za-z][A-Za-z_-]{0,15})\s*\](?!\()")
SENT_RE = re.compile(r"(?<=[.!?])\s+")
MAX_CHUNK_CHARS = 140      # a run-on sentence is cut at a comma/semicolon so the first audio comes back fast


def strip_tags(s: str) -> str:
    return re.sub(r"[ \t]{2,}", " ", TAG_RE.sub("", str(s or ""))).strip()


def _split_long(s: str) -> list:
    if len(s) <= MAX_CHUNK_CHARS:
        return [s]
    out, cur = [], ""
    for piece in re.split(r"(?<=[,;:])\s+", s):
        if cur and len(cur) + len(piece) > 100:
            out.append(cur)
            cur = piece
        else:
            cur = f"{cur} {piece}".strip()
    if cur:
        out.append(cur)
    return out


def speech_segments(text: str) -> list:
    """Spoken text (may carry tags) -> [(emotion|None, sentence)]. An emotion carries forward until the next tag."""
    segs, emo = [], None
    for part in SENT_RE.split(str(text or "").strip()):
        known = [m.group(1).lower() for m in TAG_RE.finditer(part) if m.group(1).lower() in EMOTIONS]
        if known:
            emo = known[-1]
        clean = re.sub(r"\s+", " ", TAG_RE.sub("", part)).strip()
        if not re.search(r"[A-Za-z0-9]", clean):
            continue
        segs.extend((emo, piece) for piece in _split_long(clean))
    return segs


def norm_sentence(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", re.sub(r"\s+", " ", strip_tags(s).lower())).strip()


def progress_text(raw: str) -> str:
    """Mid-turn narration -> what is worth saying: first 2 sentences, at most ~200 chars, no code/markdown."""
    raw = re.sub(r"```.*?```", " ", str(raw or ""), flags=re.S)
    flat = re.sub(r"\s+", " ", " ".join(strip_md(l) for l in raw.splitlines() if strip_md(l))).strip()
    out = ""
    for s in SENT_RE.split(flat)[:2]:
        if out and len(out) + len(s) > 200:
            break
        out = f"{out} {s}".strip()
    if len(out) > 220:
        out = out[:200].rsplit(" ", 1)[0] + "."
    return out


# ----------------------------------------------------------------------- piper
def load_voices():
    try:
        from piper import PiperVoice
    except Exception as e:  # pragma: no cover
        log.warning("piper-tts not importable (%s): every agent will beep-speak. Real voices: "
                    "pip install -r requirements-voice.txt && scripts/fetch-models.sh", e)
        return
    for agent, fname in VOICE_FILES.items():
        path = VOICES_DIR / fname
        if not path.exists():
            log.warning("voice for %s missing (%s): beep-speak fallback. Run scripts/fetch-models.sh", agent, path)
            continue
        voices[agent] = PiperVoice.load(str(path))
        log.info("loaded voice for %s: %s", agent, fname)


BABBLE_PITCH = {"alfred": 150.0, "scout": 230.0, "maker": 185.0}


def babble_pcm(agent: str, text: str, sr: int = 22050) -> bytes:
    """No Piper voice installed: a retro 'beep-speak' babble, one soft square-ish blip per syllable-ish chunk of
    text. Deterministic per text, quiet, and loud enough to drive the WebAudio lip sync."""
    import math
    import random as _r
    rnd = _r.Random(hash((agent, text)) & 0xFFFFFFFF)
    words = re.findall(r"[A-Za-z0-9']+|[.,!?;:]", text) or ["hm"]
    f0, out = BABBLE_PITCH.get(agent, 180.0), bytearray()
    for w in words:
        if w in ".!?":
            n = int(sr * 0.22)
            out += b"\x00\x00" * n
            continue
        if w in ",;:":
            out += b"\x00\x00" * int(sr * 0.12)
            continue
        for _ in range(max(1, min(4, round(len(w) / 3)))):
            dur, f = rnd.uniform(0.07, 0.11), f0 * rnd.uniform(0.85, 1.25)
            n = int(sr * dur)
            for i in range(n):
                env = min(1.0, i / (sr * 0.008)) * min(1.0, (n - i) / (sr * 0.02))
                ph = 2 * math.pi * f * i / sr
                v = 0.55 * math.sin(ph) + 0.25 * math.sin(3 * ph) + 0.12 * math.sin(5 * ph)
                out += int(max(-1.0, min(1.0, v * env)) * 9000).to_bytes(2, "little", signed=True)
            out += b"\x00\x00" * int(sr * 0.018)
        out += b"\x00\x00" * int(sr * 0.05)
    return bytes(out)


def synth_wav(agent: str, text: str) -> bytes:
    if agent not in voices:
        return wav_bytes(babble_pcm(agent, text), 22050)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voices[agent].synthesize_wav(text, wf)
    return buf.getvalue()


async def synthesize(agent: str, text: str) -> bytes:
    loop = asyncio.get_running_loop()
    async with synth_lock:
        return await loop.run_in_executor(None, synth_wav, agent, text)


# One synthesis thread: sentences are made one at a time (keeps this 2017 dual-core calm and the order fixed);
# the event loop never waits on Piper.
synth_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="piper")


def synth_pcm(agent: str, text: str):
    """One sentence -> (int16 mono PCM bytes, sample_rate). Piper's streaming API yields one AudioChunk per
    sentence it finds; normally exactly one here because we already split by sentence."""
    pcm, sr = [], 22050
    if agent not in voices:
        return babble_pcm(agent, text, sr), sr
    for ch in voices[agent].synthesize(text):
        pcm.append(ch.audio_int16_bytes)
        sr = ch.sample_rate
    return b"".join(pcm), sr


def wav_bytes(pcm: bytes, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_url(pcm: bytes, sr: int) -> str:
    return "data:audio/wav;base64," + base64.b64encode(wav_bytes(pcm, sr)).decode()


# ------------------------------------------------------------------- messaging
async def broadcast(msg: dict, want: str = ""):
    """want='stream' -> only displays that announced caps:['stream']; want='legacy' -> only the others."""
    data = json.dumps(msg)
    for ws in list(clients):
        if want and (("stream" in ws_caps.get(id(ws), ())) != (want == "stream")):
            continue
        try:
            await ws.send_str(data)
        except Exception:
            clients.discard(ws)


def client_kinds():
    st = sum(1 for ws in clients if "stream" in ws_caps.get(id(ws), ()))
    return st, len(clients) - st


# ----------------------------------------------------------------------- crew
# Who is thinking / working right now, per agent. Pushed by the Hermes hook via POST /activity,
# expires on its own if an agent goes quiet (crashed turn, long gap) so a stale badge can't stick.
CREW_TTL = 120.0
crew = {a: {"status": "idle", "label": "", "ts": 0.0} for a in ("alfred", "scout", "maker")}


# v1.1 CREW window: when the current status began, and the last finished thing (label + time) per agent.
# Derived from the same /activity events (no new hook traffic); kept in memory, lost on restart.
crew_meta = {a: {"since": time.time(), "busy_since": 0.0, "busy": "", "spoke": False, "last": None, "hist": []}
             for a in crew}
CREW_SKIP_LAST = {"", "THINKING", "LISTENING", "HEARD YOU", "PREPARING VOICE", "SPEAKING", "WORKING"}


def crew_note(agent: str, status: str, label: str = "", ttl: bool = False):
    """Call BEFORE crew[agent] changes: tracks status start + the last completed activity."""
    m = crew_meta.get(agent)
    if m is None:
        return
    prev, now = crew[agent]["status"], time.time()
    if status != prev:
        m["since"] = now
    if prev == "idle" and status != "idle":
        m.update(busy_since=now, busy="", spoke=False)
    if status != "idle":
        if label == "PREPARING VOICE":
            m["spoke"] = True
        elif label not in CREW_SKIP_LAST:
            m["busy"] = label
    elif prev != "idle":
        took = now - (m["busy_since"] or now)
        lab = m["busy"] or ("REPLIED" if m["spoke"] or (took >= 5 and not ttl) else "")
        if lab:
            m["last"] = {"label": lab, "at": now, "took": round(took)}
            if m["hist"] and m["hist"][0]["label"] == lab:
                m["hist"][0] = m["last"]
            else:
                m["hist"] = ([m["last"]] + m["hist"])[:4]
        m.update(busy="", spoke=False)


def crew_public() -> dict:
    out = {}
    for a, v in crew.items():
        m = crew_meta.get(a) or {}
        out[a] = dict(v, since=m.get("since"), last=m.get("last"), hist=m.get("hist") or [])
    return {"type": "crew", "crew": out}


async def set_crew(agent: str, status: str, label: str = ""):
    cur = crew[agent]
    changed = (cur["status"], cur["label"]) != (status, label)
    crew_note(agent, status, label)
    crew[agent] = {"status": status, "label": label, "ts": time.time()}
    if changed:
        await broadcast(crew_public())


async def crew_loop():
    while True:
        await asyncio.sleep(5)
        now, dirty = time.time(), False
        for a, v in crew.items():
            if v["status"] != "idle" and now - v["ts"] > CREW_TTL:
                crew_note(a, "idle", ttl=True)
                crew[a] = {"status": "idle", "label": "", "ts": now}; dirty = True
        if dirty:
            await broadcast(crew_public())


TMUX = shutil.which("tmux") or "/usr/local/bin/tmux"
VOICE_SESSION = config.VOICE_SESSION
vlog = logging.getLogger("retro-mac.voice")

# ----------------------------------------------------------------- voice state
# One state machine for a spoken interaction, rendered by web/banner.js as a big status banner.
#   heard -> listening -> transcribing ("GOT IT") -> working (turn running) -> speaking -> done -> idle
#   side exits: error ("DIDN'T CATCH THAT", lost turn), stopped (stop / cancel),
#   failed ("LIMIT HIT - TRY AGAIN AT 11:10 PM" / "SOMETHING WENT WRONG": the voice turn died on a provider error;
#   detected by watch_fail_loop reading the hermes-voice pane, or POST /voice_error)
# `turn` is the voice-originated agent turn that is running (it can outlive a barge-in listen).
# Inputs: wake daemon (/voice_state heard|listening|idle|error, /level), the tmux REC poll below,
# the retro_mac_face plugin (/voice_turn at turn start, /activity labels + heartbeats, /speak voice=...).
FULL_STATES = ("heard", "listening", "transcribing", "working", "error", "done", "stopped", "failed")
VOICE_STATES = ("idle", "speaking") + FULL_STATES
VOICE_PLATFORMS = ("tui", "cli", "local", "desktop", "")
REVIEW_PREFIXES = ("Review the conversation above",)
RESULT_PREFIXES = ("[IMPORTANT: Background process", "[ASYNC DELEGATION COMPLETE")
QUIET_PREFIXES = ("[Background process",)            # heartbeat ticks of a background job: never spoken
CANCEL_PHRASES = {"cancel", "cancel that", "cancel it", "never mind", "nevermind", "stop it", "stop that",
                  "forget it", "abort", "alfred cancel", "alfred stop"}
ACK_AFTER = 8.0          # canned first ack ("Looking that up." / "On it.") if the model has said nothing by then
STILL_FIRST, STILL_EVERY, STILL_MAX = 60.0, 90.0, 3
TURN_LOST_AFTER = 180.0  # no heartbeat from the turn's session for this long = it died
TURN_MAX = 30 * 60.0
PENDING_TTL = 60 * 60.0
HOLD = {"done": 3.0, "error": 6.0, "stopped": 3.0, "failed": 8.0}
STUCK_AFTER = float(os.environ.get("RETRO_MAC_STUCK_AFTER", "180"))   # WORKING this long with no tool/narration = watchdog
FAIL_SAY = {"limit": "I've hit my usage limit.", "generic": "Sorry, that didn't work."}
# What the Hermes TUI prints when a turn dies (agent/turn_failure_copy.py). Counted in the pane while a voice turn runs.
FAIL_MARK_RE = re.compile(r"This turn did not complete", re.I)
LIMIT_MARK_RE = re.compile(r"rate-limited every one of|usage limit|HTTP 429|Limit resets at", re.I)
PANE_ART_RE = re.compile(r"[\u2500-\u259f]+")

voice = {"state": "idle", "since": time.time(), "note": "", "followup": False, "window": 0.0,
         "rec_start": 0.0, "rec_end": 0.0, "speak_until": 0.0, "say": None, "fail": None}
fail_log = {"last": None, "count": 0}
junk_log = {"at": 0.0, "count": 0, "last": ""}   # junk transcripts dropped (never spoken); the wake daemon reads `at`
JUNK_HOLD = 3.0                                  # quiet DIDN'T CATCH THAT banner, seconds (no audio)
turn = {"t": None}        # {session, agent, text, label, started, beat, acks, kind}
pending_jobs = []         # [{id, label, since, session}]
voice_session = {"id": ""}
last_reply = {"kind": "", "at": 0.0}
level = {"l": 0.0, "s": 0.0, "sp": False, "at": 0.0}
hook_seen = {"v4": 0.0}   # last /activity carrying session_id (= the v0.4 plugin is live in the gateway)
ws_builds = {}            # ws id -> web build the page says it runs ("old" until it reports)
ws_caps = {}              # ws id -> set of capabilities from the page's hello (e.g. {"stream"})
tui = {"seen": False, "rec": False, "voice_on": None, "ready": None, "first": 0.0, "healed_at": 0.0}

# Speech pipeline: one queue, one worker, one sentence at a time. gen bumps on stop so queued and in-flight
# sentences are dropped; play_end models when the display will finish playing what it has been sent.
speech = {"gen": 0, "uid": 0, "busy": False, "play_end": 0.0, "last": {}}
speech_q: "asyncio.Queue[dict]" = asyncio.Queue()


def clean_text(s, n=300) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s[:n]


LOG_TEXT = 40    # spoken replies and transcripts are cut to this many chars in the log (privacy + log size)


def snip(s) -> str:
    s = clean_text(s, LOG_TEXT + 1)
    return s if len(s) <= LOG_TEXT else s[:LOG_TEXT] + "..."


def voice_public() -> dict:
    t = turn["t"]
    now = time.time()
    return {
        "type": "voice", "state": voice["state"], "since": voice["since"], "now": now,
        "note": voice["note"], "followup": voice["followup"], "window": voice["window"],
        "armed": now < armed["until"], "ptt": bool(settings.get("ptt")),
        "turn": ({"text": t["text"], "label": t["label"], "started": t["started"], "agent": t["agent"],
                  "kind": t["kind"], "stuck": bool(t.get("stuck")), "steps": [{"text": s["text"], "done": s["done"]} for s in t.get("steps", [])[-6:]]}
                 if t else None),
        "pending": [{"label": j["label"], "since": j["since"]} for j in pending_jobs],
        "say": voice["say"] if voice["say"] and now < voice["say"]["until"] + 1.0 else None,   # narration playing
        "fail": voice["fail"] if voice["state"] == "failed" else None,
    }


async def set_voice(state: str, note: str = "", **kw):
    prev = voice["state"]
    hold = kw.pop("hold", 0.0)
    voice.update(state=state, since=time.time(), note=note, hold=hold, **kw)
    t = turn["t"]
    vlog.info("voice %s -> %s%s%s", prev, state, f" [{note}]" if note else "",
              f" turn={t['kind']}:{t['label']!r} {snip(t['text'])!r}" if t else "")
    await broadcast(voice_public())


async def end_turn(state: str = "done", note: str = ""):
    turn["t"] = None
    await set_voice(state, note)


def parse_reset(text: str):
    """'Limit resets at 23:10 (in 1h 49m).' -> {'at': '11:10 PM', 'say': '11:10 PM'}; 'resets in ~2h' -> relative."""
    m = re.search(r"resets? at (\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?", text, re.I)
    if m:
        h, mi, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower().replace(".", "")
        if ap == "pm" and h < 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        if h < 24 and mi < 60:
            disp = f"{h % 12 or 12}:{mi:02d} {'PM' if h >= 12 else 'AM'}"
            return {"at": disp, "say": disp.replace(":00", "")}
    m = re.search(r"resets? in ~?(\d+)\s*(h|m)", text, re.I)
    if m:
        n, u = int(m.group(1)), m.group(2).lower()
        word = f"{n} {'hour' if u == 'h' else 'minute'}{'' if n == 1 else 's'}"
        return {"at": f"IN ~{n}{u.upper()}", "say": f"in about {word}", "rel": True}
    return None


def fail_copy(kind: str, reset) -> dict:
    """Banner note + the single spoken line for a failed voice turn."""
    if kind == "limit":
        if reset and reset.get("rel"):
            return {"note": f"TRY AGAIN {reset['at']}", "say": f"{FAIL_SAY['limit']} Try again {reset['say']}."}
        if reset:
            return {"note": f"TRY AGAIN AT {reset['at']}", "say": f"{FAIL_SAY['limit']} Try again after {reset['say']}."}
        return {"note": "TRY AGAIN LATER", "say": f"{FAIL_SAY['limit']} Try again later."}
    return {"note": "TRY AGAIN IN A MINUTE", "say": FAIL_SAY["generic"]}


async def fail_turn(kind: str, reset=None, why: str = "", force: bool = False) -> dict:
    """A voice turn died on a provider/API error. Tell the user (banner + concerned face + ONE spoken line), clear the
    running turn and the mic window, and let voice_loop return to idle after HOLD['failed'] seconds.
    Voice-originated turns only (the turn registry is only fed by the plugin's /voice_turn): Telegram/cron never get here."""
    now, t = time.time(), turn["t"]
    if voice["state"] == "failed" and now - voice["since"] < 15.0:
        return {"ok": True, "ignored": "already failed"}
    if not force and not (t and t["kind"] in ("voice", "result")):
        return {"ok": True, "ignored": "no voice turn running"}
    kind = "limit" if kind == "limit" else "generic"
    copy = fail_copy(kind, reset)
    fail = {"kind": kind, "reset": reset["at"] if reset else None, "text": copy["note"]}
    fail_log.update(last={"at": round(now, 1), "kind": kind, "reset": fail["reset"], "why": why[:60],
                          "say": copy["say"]}, count=fail_log["count"] + 1)
    vlog.warning("voice turn FAILED (%s%s) %s -> %r", kind, f", resets {fail['reset']}" if reset else "", why, copy["say"])
    speech_cancel()                                  # drop half-said narration; the failure line replaces it
    await broadcast({"type": "stop", "upto": speech["uid"]})
    for a in crew:
        if crew[a]["status"] != "idle":
            await set_crew(a, "idle", "")
    turn["t"] = None                                 # WORKING / pending turn cleared
    armed["until"] = 0.0                             # mic window released: nothing re-arms for a follow-up
    voice.update(followup=False, window=0.0, say=None)
    state.update(state="idle")
    await set_voice("failed", copy["note"], fail=fail)
    await enqueue_speech("alfred", [("concerned", copy["say"])], kind="error", progress=True)
    return {"ok": True, "kind": kind, "say": copy["say"], "note": copy["note"]}


async def pane_text(history: int = 400) -> str:
    """Text of the hermes-voice tmux pane (read-only). Tests replace this function."""
    p = await asyncio.create_subprocess_exec(
        TMUX, "capture-pane", "-p", "-S", f"-{history}", "-t", VOICE_SESSION,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    out, _ = await asyncio.wait_for(p.communicate(), 3)
    return out.decode("utf-8", "ignore") if p.returncode == 0 else ""


def pane_marks(raw: str):
    """-> (count of failure markers, normalized text). Box/mascot art is stripped and whitespace collapsed, so a
    line wrapped by the TUI still matches."""
    text = re.sub(r"\s+", " ", PANE_ART_RE.sub(" ", raw))
    return len(FAIL_MARK_RE.findall(text)) + len(re.findall(r"rate-limited every one of", text, re.I)), text


def classify_failure(text: str):
    """Look at the text around the NEWEST failure marker only (older failures stay in the scrollback)."""
    ends = [m.end() for m in FAIL_MARK_RE.finditer(text)]
    last = ends[-1] if ends else len(text)
    prev = ends[-2] if len(ends) > 1 else max(0, last - 1500)
    ctx = text[prev:last]
    rl = list(re.finditer(r"rate-limited every one of", ctx, re.I))
    if rl:
        ctx = ctx[rl[-1].start():]
    if LIMIT_MARK_RE.search(ctx):
        return "limit", parse_reset(ctx)
    return "generic", None


async def watch_fail_loop():
    """While a voice turn runs, watch the hermes-voice pane for the TUI's failure text. The turn_failure_copy
    message ('... rate-limited every one of 3 attempts ... Limit resets at 23:10 ... This turn did not complete')
    is printed only to the TUI, and Hermes fires no plugin hook for a turn that ends in an error, so this is the
    one signal that always exists. The count of markers is baselined at the start of each turn."""
    base, sid = None, None
    while True:
        await asyncio.sleep(1.0)
        try:
            t = turn["t"]
            if not t or t["kind"] not in ("voice", "result"):
                base = sid = None
                continue
            raw = await pane_text()
            n, text = pane_marks(raw)
            if sid != t["session"] or base is None:
                base, sid = n, t["session"]
                continue
            if n > base:
                await asyncio.sleep(0.6)                  # let the rest of the message finish rendering
                n, text = pane_marks(await pane_text())
                kind, reset = classify_failure(text)
                base = n
                if turn["t"] is t:
                    await fail_turn(kind, reset, why="tui pane")
            else:
                base = min(base, n)
        except Exception:
            log.exception("fail watch")


async def tmux_keys(*keys, literal=False):
    if DEMO:
        return                     # demo mode never touches a terminal session
    args = [TMUX, "send-keys", "-t", VOICE_SESSION] + (["-l"] if literal else []) + list(keys)
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await asyncio.wait_for(p.wait(), 3)


async def voice_on_again(reason: str):
    """The TUI's own voice chat switched off (spoken bare 'stop', or 3 silent captures). The wake word is our
    real gate, so turn the plumbing back on, or the next 'Alfred' would press a dead record key."""
    if time.time() - tui["healed_at"] < 60:
        return
    tui["healed_at"] = time.time()
    await asyncio.sleep(1.0)
    vlog.info("voice session: voice went off (%s); sending /voice on", reason)
    await tmux_keys("/voice on", literal=True)
    await asyncio.sleep(0.3)
    await tmux_keys("Enter")


async def interrupt_voice_agent(why: str):
    """Double-Esc interrupts a running TUI turn (and is a no-op when idle, unlike Ctrl-C which would exit)."""
    vlog.info("interrupting voice agent (%s)", why)
    await tmux_keys("Escape")
    await asyncio.sleep(0.25)
    await tmux_keys("Escape")


async def voice_stop(why: str, interrupt: bool):
    speak_until["t"] = 0.0
    voice["speak_until"] = 0.0
    state.update(state="idle")
    speech_cancel()
    await broadcast({"type": "stop", "upto": speech["uid"]})
    if interrupt and turn["t"] and tui["ready"] is False:
        await interrupt_voice_agent(why)
    await end_turn("stopped", why)


async def voice_watch_loop():
    """The voice listener is a Hermes TUI inside tmux. Polling its pane (read-only, ~10ms) tells us:
    '● REC' = capturing your voice; status line 'ready' = idle, else busy; 'voice on' = record key live."""
    rec = False
    while True:
        await asyncio.sleep(0.5)
        lines = []
        try:
            p = await asyncio.create_subprocess_exec(
                TMUX, "capture-pane", "-p", "-t", VOICE_SESSION,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), 3)
            lines = out.decode("utf-8", "ignore").splitlines() if p.returncode == 0 else []
        except Exception:
            lines = []
        tail = "\n".join(lines[-6:])
        now_rec = "● REC" in tail
        status = next((l for l in reversed(lines[-6:]) if "│" in l and l.strip().startswith("─")), "")
        if status:
            if not tui["seen"]:
                tui.update(seen=True, first=time.time())
            was_on = tui["voice_on"]
            tui["ready"] = status.strip().startswith("─ ready")
            tui["voice_on"] = now_rec or "voice on" in status
            if was_on and not tui["voice_on"] and time.time() - tui["first"] > 60:
                recent = "\n".join(lines[-40:])
                if "stop phrase" in recent:          # he said a bare "stop": cut speech, stop the job, keep voice alive
                    await voice_stop("STOPPED BY VOICE", interrupt=True)
                    asyncio.create_task(voice_on_again("stop phrase"))
                else:
                    asyncio.create_task(voice_on_again("no speech limit" if "no speech" in recent else "voice off"))
        tui["rec"] = now_rec
        now = time.time()
        if now_rec and not rec:
            await set_crew("alfred", "listening", "LISTENING")
            voice["rec_start"] = now
            if voice["state"] != "listening":
                await set_voice("listening", followup=voice["followup"] if voice["state"] == "heard" else False,
                                window=voice["window"] if voice["state"] == "heard" else 0.0)
        elif rec and not now_rec:
            voice["rec_end"] = now
            if crew["alfred"]["status"] == "listening":
                await set_crew("alfred", "thinking", "HEARD YOU")   # hooks refine this once the turn starts
            if voice["state"] in ("listening", "heard"):
                await set_voice("transcribing")
        elif now_rec:
            crew["alfred"]["ts"] = now                         # keep the TTL alive while recording
        rec = now_rec


async def speak_progress(text: str):
    """Canned spoken progress line ("On it." / "Still working.") for a running voice turn, used only when the
    model itself has not narrated. No card, no crew/turn changes, never opens a follow-up mic window."""
    await enqueue_speech("alfred", [(None, text)], kind="progress", progress=True)
    vlog.info("progress spoken (canned): %r", text)


async def voice_loop():
    """Timers: state holds, transcription timeout, spoken acks, lost-turn watchdog, pending TTL, web reloads."""
    build = web_build()
    tick = 0
    while True:
        await asyncio.sleep(0.5)
        tick += 1
        now = time.time()
        st, age, t = voice["state"], now - voice["since"], turn["t"]
        talking = speech["busy"] or not speech_q.empty()
        try:
            if st == "heard" and age > 1.0 and not tui["rec"]:
                await set_voice("listening", followup=voice["followup"], window=voice["window"])
            elif st == "listening" and age > max(20.0, voice["window"] + 12) and not tui["rec"]:
                if t:
                    await set_voice("working")
                else:
                    await end_turn("error", ("VOICE WAS OFF. TAP SPACE AGAIN" if settings.get("ptt") else "VOICE WAS OFF. SAY ALFRED AGAIN") if tui["voice_on"] is False
                                   else "THE MIC DID NOT OPEN. TRY AGAIN")
            elif st == "transcribing":
                rec_len = max(0.0, voice["rec_end"] - voice["rec_start"])
                if age > 20 + 0.8 * rec_len:            # whisper takes ~0.7x the clip length here
                    if t:
                        await set_voice("working", "DIDN'T CATCH THAT. STILL ON THE LAST ASK")
                    else:
                        await set_voice("error", retry_hint())
            elif st == "speaking" and now > voice["speak_until"] + 0.3 and not talking:
                await set_voice("done")
            elif st in HOLD and age > (voice.get("hold") or HOLD[st]):
                await set_voice("working" if t else "idle")
            if t:
                el = now - t["started"]
                if now - t["beat"] > TURN_LOST_AFTER or el > TURN_MAX:
                    vlog.warning("voice turn lost (no heartbeat %.0fs, elapsed %.0fs)", now - t["beat"], el)
                    await end_turn("error", "LOST TRACK OF THAT ONE. CHECK HERMES")
                elif (st == "working" and t["kind"] == "voice" and not t.get("hush") and now < armed["until"]
                      and speak_until["t"] < now and not talking):
                    # Real narration from the model (voice=progress) replaces the canned lines; they only fill
                    # silences: the first ack if nothing was said by ACK_AFTER, then "Still working." after
                    # STILL_FIRST / STILL_EVERY seconds without any spoken line.
                    quiet = now - max(t["started"], t.get("narr_at", 0.0), t.get("ack_at", 0.0))
                    if t["acks"] == 0:
                        if t.get("narr_at"):
                            t["acks"] = 1
                        elif el >= ACK_AFTER:
                            t["acks"], t["ack_at"] = 1, now
                            asyncio.create_task(speak_progress(t.get("say") or "On it."))
                    elif t["acks"] <= STILL_MAX and quiet >= (STILL_FIRST if t["acks"] == 1 else STILL_EVERY):
                        t["acks"] += 1
                        t["ack_at"] = now
                        asyncio.create_task(speak_progress("Still working."))
            if (t and st == "working" and t["kind"] == "voice" and not t.get("stuck")
                    and now - max(t["started"], t.get("act", 0.0), t.get("narr_at", 0.0)) > STUCK_AFTER):
                # Watchdog: no tool activity, no narration, no reply for STUCK_AFTER seconds. Heartbeats do not count.
                t["stuck"] = True
                vlog.warning("voice turn stuck: no activity for %.0fs", now - max(t["started"], t.get("act", 0.0), t.get("narr_at", 0.0)))
                await broadcast(voice_public())
                if not t.get("hush") and not talking and not t.get("stuck_said"):
                    t["stuck_said"] = True               # spoken once per turn, even if it un-sticks and sticks again
                    asyncio.create_task(speak_progress("Still trying. Tap the screen to cancel."))
            if pending_jobs and any(now - j["since"] > PENDING_TTL for j in pending_jobs):
                pending_jobs[:] = [j for j in pending_jobs if now - j["since"] <= PENDING_TTL]
                await broadcast(voice_public())
            if tick % 10 == 0:                           # web files edited -> every display reloads itself
                b = web_build()
                if b != build:
                    build = b
                    log.info("web files changed (build %s): telling displays to reload", b)
                    await broadcast({"type": "hello", "build": b})
        except Exception:
            log.exception("voice loop")


def web_build() -> str:
    h = hashlib.sha1()
    for f in sorted(WEB.glob("*")):
        if f.suffix in (".js", ".html", ".css"):
            st = f.stat()
            h.update(f"{f.name}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:10]


async def read_json(request):
    try:
        return await request.json()
    except Exception:
        return None


async def handle_voice_state(request: web.Request):
    if request.method == "GET":
        return web.json_response(voice_public())
    body = await read_json(request)
    if not isinstance(body, dict) or body.get("state") not in VOICE_STATES:
        return web.json_response({"ok": False, "error": "bad state"}, status=400)
    st, note = body["state"], clean_text(body.get("note"), 60).upper()
    t = turn["t"]
    if st == "heard":
        await set_voice("heard", followup=False, window=float(body.get("window") or 5.0))
    elif st == "listening":
        await set_voice("listening", followup=bool(body.get("followup")), window=float(body.get("window") or 0.0))
    elif st == "idle":                                # e.g. a follow-up window closed with nobody talking
        if voice["state"] == "failed" and time.time() - voice["since"] < HOLD["failed"]:
            return web.json_response({"ok": True, "state": "failed", "ignored": "failure banner is showing"})
        await set_voice("working" if t else "idle", note)
    elif st == "failed":                              # same as POST /voice_error {kind: generic}
        return web.json_response(await fail_turn("generic", why="voice_state", force=bool(body.get("force"))))
    elif st == "done":                                # plugin: voice turn ended without anything to say
        if t and body.get("session_id") and body["session_id"] != t["session"]:
            return web.json_response({"ok": True, "ignored": "other session"})
        await end_turn("done", note)
    elif st == "error":
        if t:
            await set_voice("working", note or "DIDN'T CATCH THAT. STILL ON THE LAST ASK")
        else:
            await set_voice("error", note or retry_hint())
    elif st == "stopped":
        await voice_stop(note or "STOPPED", interrupt=bool(body.get("interrupt")))
    else:
        await set_voice(st, note)
    return web.json_response({"ok": True, "state": voice["state"]})


async def handle_voice_error(request: web.Request):
    """POST {kind: limit|generic, text?: <provider/TUI error text>, session_id?, force?}. Anything that learns a
    voice turn died (the pane watcher uses fail_turn directly; this is for hooks / wake daemon / tests)."""
    body = await read_json(request)
    if not isinstance(body, dict):
        return web.json_response({"ok": False}, status=400)
    text = re.sub(r"\s+", " ", str(body.get("text") or ""))[:2000]
    kind, reset = classify_failure(text) if text else ("generic", None)
    if body.get("kind") in ("limit", "generic"):
        kind = body["kind"]
    sid, t = str(body.get("session_id") or ""), turn["t"]
    if t and sid and sid != t["session"]:
        return web.json_response({"ok": True, "ignored": "other session"})
    return web.json_response(await fail_turn(kind, reset, why="POST /voice_error", force=bool(body.get("force"))))


async def junk_turn(text: str, sid: str = "") -> dict:
    """A voice recording whose transcript is noise ([BLANK_AUDIO], (inaudible), a lone "you" ...). It is NOT a turn:
    nothing is spoken, no follow-up mic, the mic window is released, the banner shows DIDN'T CATCH THAT for ~3 s
    without sound. A real turn that is already running (barge-in noise) is left alone."""
    now, t = time.time(), turn["t"]
    junk_log.update(at=now, count=junk_log["count"] + 1, last=clean_text(text, 40))
    vlog.info("junk transcript dropped (not spoken): %r%s", snip(text), " [turn running: ignored]" if t else "")
    if t:
        return {"ok": True, "ignored": "turn running"}
    armed["until"] = 0.0                              # replies stay muted; nothing re-arms the mic
    last_reply.update(kind="", at=0.0)                # no follow-up window after this
    voice.update(followup=False, window=0.0, say=None)
    state.update(state="idle")
    for a in crew:
        if crew[a]["status"] != "idle":
            await set_crew(a, "idle", "")
    await set_voice("error", "NO SPEECH HEARD", hold=JUNK_HOLD)
    return {"ok": True}


async def handle_voice_junk(request: web.Request):
    """Plugin: the transcript of this voice turn is junk and the turn was blocked before the model call."""
    body = await read_json(request)
    if not isinstance(body, dict):
        return web.json_response({"ok": False}, status=400)
    return web.json_response(await junk_turn(str(body.get("text") or ""), str(body.get("session_id") or "")))


async def handle_voice_turn(request: web.Request):
    """Called by the plugin at the start of every local (non chat-app) turn. Decides whether the turn came
    from the user's voice and returns {kind}: voice | result | cancel | quiet | none."""
    body = await read_json(request)
    if not isinstance(body, dict):
        return web.json_response({"ok": False}, status=400)
    agent, sid = norm_agent(body.get("agent")), str(body.get("session_id") or "")
    plat = str(body.get("platform") or "").lower()
    raw = str(body.get("text") or "").strip()
    now, kind = time.time(), "none"
    recent_voice = voice["state"] in ("heard", "listening", "transcribing") and now - voice["since"] < 180
    if raw.startswith(REVIEW_PREFIXES):
        kind = "none"
    elif sid and sid == voice_session["id"] and raw.startswith(RESULT_PREFIXES):
        kind = "result"
    elif sid and sid == voice_session["id"] and raw.startswith(QUIET_PREFIXES):
        kind = "quiet"
    elif plat in VOICE_PLATFORMS and agent == "alfred" and (body.get("marker") or recent_voice):
        if is_junk(raw):
            await junk_turn(raw, sid)
            return web.json_response({"ok": True, "kind": "junk"})
        kind = "cancel" if re.sub(r"[^a-z ]", "", raw.lower()).strip() in CANCEL_PHRASES else "voice"
    if kind == "none":
        return web.json_response({"ok": True, "kind": kind})
    if kind in ("voice", "cancel"):
        voice_session["id"] = sid or voice_session["id"]
    prev = turn["t"]
    if kind == "cancel":
        await voice_stop("CANCELLED", interrupt=False)    # the TUI's busy-input interrupt already stopped the job
        return web.json_response({"ok": True, "kind": kind})
    if kind == "quiet":
        if prev:
            prev["beat"] = now
        return web.json_response({"ok": True, "kind": kind})
    text = "BACKGROUND JOB FINISHED" if kind == "result" else clean_text(raw, 300)
    turn["t"] = {"session": sid, "agent": agent, "text": text, "label": "THINKING", "started": now,
                 "beat": now, "acks": 0 if kind == "voice" else 99, "kind": kind}
    note = "NEW ASK. THE LAST ONE WAS STOPPED" if prev and prev["kind"] == "voice" and kind == "voice" else ""
    await set_voice("working", note)
    return web.json_response({"ok": True, "kind": kind})


async def handle_level(request: web.Request):
    body = await read_json(request) or {}
    if voice["state"] in ("heard", "listening"):
        try:
            level.update(l=max(0.0, min(1.0, float(body.get("l", 0)))), s=float(body.get("s", 0)),
                         sp=bool(body.get("sp")), at=time.time())
        except (TypeError, ValueError):
            return web.json_response({"ok": False}, status=400)
        await broadcast({"type": "level", "l": round(level["l"], 3), "s": round(level["s"], 2), "sp": level["sp"]})
    return web.json_response({"ok": True, "state": voice["state"]})


async def handle_voice_pending(request: web.Request):
    body = await read_json(request) or {}
    op = body.get("op")
    if op == "add":
        pending_jobs.append({"id": str(body.get("id") or time.time()), "since": time.time(),
                             "label": clean_text(body.get("label") or "BACKGROUND JOB", 28).upper(),
                             "session": str(body.get("session_id") or "")})
        vlog.info("voice job pending: %s (%d now)", pending_jobs[-1]["label"], len(pending_jobs))
    elif op == "done" and pending_jobs:
        jid = str(body.get("id") or "")
        idx = next((i for i, j in enumerate(pending_jobs) if j["id"] == jid), 0)
        vlog.info("voice job done: %s", pending_jobs.pop(idx)["label"])
    elif op == "clear":
        pending_jobs.clear()
    elif op not in ("done",):
        return web.json_response({"ok": False, "error": "op must be add|done|clear"}, status=400)
    await broadcast(voice_public())
    return web.json_response({"ok": True, "pending": len(pending_jobs)})


async def handle_activity(request: web.Request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    status = body.get("status")
    if status not in ("idle", "thinking", "working", "listening"):
        return web.json_response({"ok": False, "error": "bad status"}, status=400)
    label = re.sub(r"[^\w .:/+\-]", "", str(body.get("label") or ""))[:28].upper() if status != "idle" else ""
    agent = norm_agent(body.get("agent"))
    await set_crew(agent, status, label)
    t, sid = turn["t"], str(body.get("session_id") or "")
    if "session_id" in body:
        hook_seen["v4"] = time.time()
    if t and status != "idle" and ((sid and sid == t["session"]) or (not sid and agent == t["agent"])):
        t["beat"] = time.time()                       # 15s heartbeats from the hook keep a long turn alive
        dirty = False
        if label and label not in ("LISTENING", "HEARD YOU", "PREPARING VOICE") and label != t["label"]:
            t["label"] = label
            dirty = True
        # Step checklist (voice turns only): the hook sends a human caption at each tool start and step=done
        # with the same call_id when it returns. The banner shows the last few with a spinner / check mark.
        step, cid = body.get("step"), str(body.get("call_id") or "")[:80]
        caption = re.sub(r"[^\w .:/+\-'\"@#&?,!()]", "", str(body.get("caption") or "")).strip()[:44].upper()
        if t["kind"] == "voice" and step in ("start", "done"):
            steps = t.setdefault("steps", [])
            if step == "start" and caption:
                steps.append({"id": cid, "text": caption, "done": False, "at": time.time()})
                del steps[:-12]
                say = re.sub(r"[^\w .,'!?-]", "", str(body.get("say") or ""))[:60].strip()
                if say:
                    t["say"] = say                    # canned first ack becomes "Looking that up." etc.
                dirty = True
            elif step == "done":
                for s in steps:
                    if not s["done"] and (s["id"] == cid or not cid):
                        s["done"] = True
                        dirty = True
                        break
        if dirty:
            t["act"] = time.time()                   # real activity (new label / tool start / tool done)
            t["stuck"] = False                       # it moved again: back to the normal banner
        if dirty and voice["state"] == "working":
            await broadcast(voice_public())
    return web.json_response({"ok": True})


def norm_agent(a) -> str:
    a = str(a or "alfred").strip().lower()
    return a if a in AGENTS else "alfred"


# ------------------------------------------------------------------- guard
# One gate for every request (DNS rebinding + cross-site requests from any web page the kiosk machine opens):
#  - Host must be this server itself (127.0.0.1 / localhost / [::1] on our port), else 421 for every path;
#  - anything that changes state (any non-GET, incl. /refresh) and the /ws upgrade must carry no Origin
#    (curl, the Hermes plugin, the wake daemon) or our own origin, else 403.
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def allowed_hosts() -> set:
    return {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}


def host_ok(request: web.Request) -> bool:
    return (request.headers.get("Host") or "").strip().lower() in allowed_hosts()


def origin_ok(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if origin is None:
        return True  # curl / python callers send no Origin
    return origin.strip().lower() in {f"http://{h}" for h in allowed_hosts()}


@web.middleware
async def guard(request: web.Request, handler):
    if not host_ok(request):
        log.warning("blocked request with foreign Host %r: %s %s", request.headers.get("Host", "")[:60],
                    request.method, request.path)
        return web.json_response({"ok": False, "error": "bad host"}, status=421)
    upgrade = request.path == "/ws" or "websocket" in request.headers.get("Upgrade", "").lower()
    if (request.method not in SAFE_METHODS or upgrade) and not origin_ok(request):
        log.warning("blocked %s %s from foreign Origin %r", request.method, request.path,
                    request.headers.get("Origin", "")[:60])
        return web.json_response({"ok": False, "error": "bad origin"}, status=403)
    return await handler(request)


async def handle_speak(request: web.Request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    agent = norm_agent(body.get("agent"))
    raw = str(body.get("text") or "").strip()
    if not raw:
        return web.json_response({"ok": False, "error": "no text"}, status=400)
    t_recv = time.time()
    if body.get("voice") == "progress":
        return await speak_narration(agent, raw, str(body.get("session_id") or ""), t_recv)
    kind = body.get("voice") if body.get("voice") in ("voice", "result") else ""
    sid, now, t = str(body.get("session_id") or ""), time.time(), turn["t"]
    allowed = now <= armed["until"] or bool(body.get("force")) or "test" in request.headers.get("Referer", "")
    why = "not armed"
    if kind == "voice" and t and sid == t["session"] and not t.get("hush"):
        allowed = True        # the answer to a question he asked out loud, even if the job outlived the armed window
    if kind == "voice" and voice["state"] in ("heard", "listening", "transcribing"):
        allowed, why = False, "stale: he is talking again"      # reply to an ask he just talked over
    elif kind == "result" and pending_jobs:
        allowed = True                                           # he asked for this by voice, even if long ago
        idx = next((i for i, j in enumerate(pending_jobs) if j["session"] == sid), 0)
        vlog.info("voice job result -> speaking (%s)", pending_jobs.pop(idx)["label"])
    elif agent != "alfred" and pending_jobs and not body.get("force"):
        allowed, why = False, "worker result: Alfred relays it"  # one voice per finished job
    if not allowed:
        # Nobody asked by voice: stay quiet (he may be in another room). Just clear the "working" badge.
        if crew[agent]["status"] != "idle":
            await set_crew(agent, "idle", "")
        if kind and t and (not sid or sid == t["session"]) and why != "stale: he is talking again":
            await end_turn("done")
        if kind:
            vlog.info("voice reply muted (%s)", why)
        return web.json_response({"ok": True, "agent": agent, "muted": True, "why": why}, status=202)
    armed["until"] = max(armed["until"], now + 45)   # keep the conversation open while replies are still coming
    said = set(t.get("said") or ()) if (kind == "voice" and t and sid == t["session"]) else None
    asyncio.create_task(process_speak(agent, raw, body.get("card"), kind, sid, said, t_recv))
    return web.json_response({"ok": True, "agent": agent, "kind": kind}, status=202)


async def speak_narration(agent: str, raw: str, sid: str, t_recv: float):
    """voice=progress: what the model said before / between tool calls in a voice turn ("Checking your calendar.").
    Spoken in order through the same queue, only for the running voice turn of that session, never after it ended,
    never once he tapped stop, never while he is talking again. Replaces the canned "On it."."""
    t, now = turn["t"], time.time()
    why = ""
    if not t or t["kind"] != "voice" or not sid or sid != t["session"]:
        why = "no running voice turn for this session"
    elif t.get("hush"):
        why = "stopped by tap"
    elif voice["state"] in ("heard", "listening", "transcribing"):
        why = "he is talking again"
    text = progress_text(raw) if not why else ""
    segs = speech_segments(text) if text else []
    if not why and not segs:
        why = "nothing speakable"
    if why:
        vlog.info("narration muted (%s): %r", why, snip(raw))
        return web.json_response({"ok": True, "muted": True, "why": why}, status=202)
    t["narr_at"] = now
    t["stuck"] = False
    t.setdefault("said", set()).update(norm_sentence(s) for _, s in segs)
    t["beat"] = now
    vlog.info("narration -> speaking: %r", snip(" ".join(s for _, s in segs)))
    await enqueue_speech(agent, segs, kind="progress", sid=sid, progress=True, t_recv=t_recv)
    return web.json_response({"ok": True, "agent": agent, "kind": "progress"}, status=202)


async def handle_arm(request: web.Request):
    """Wake word heard (or a follow-up mic window opened): allow spoken replies for the next N seconds."""
    try:
        secs = float((await request.json()).get("secs", 600))
    except Exception:
        secs = 600.0
    armed["until"] = time.time() + max(5.0, min(secs, 1800.0))
    return web.json_response({"ok": True, "armed_for": round(armed["until"] - time.time(), 1)})


async def handle_disarm(request: web.Request):
    armed["until"] = 0.0
    return web.json_response({"ok": True})


def retry_hint() -> str:
    return "TAP SPACE AND TRY AGAIN" if settings.get("ptt") else 'SAY "ALFRED" AND TRY AGAIN'


async def handle_ptt_seen(request: web.Request):
    """Debug breadcrumb from face.js: a Space keydown reached the kiosk page (focus/visibility/ptt state in the body)."""
    try:
        info = await request.json()
    except Exception:
        info = {}
    info = {str(k)[:12]: (v if isinstance(v, (bool, int, float)) or v is None else str(v)[:16]) for k, v in list(info.items())[:10]}
    ptt_seen.update(n=ptt_seen["n"] + 1, at=time.time(), info=info)
    vlog.info("ptt_seen: Space reached page %s", info)
    return web.json_response({"ok": True})


async def handle_ptt(request: web.Request):
    """Push-to-talk (kiosk Space bar), only while settings.ptt is on. One endpoint, the server decides:
    recording -> Ctrl-B again (stop + transcribe); busy (speaking / turn running / transcribing) -> 409, nothing happens;
    otherwise start a listening turn exactly like a wake word: arm 600 s, HEARD banner, crew listening, Ctrl-B in the
    hermes-voice TUI. The wake daemon follows ptt_req for the mic meter and the 8 s no-speech close."""
    if not settings.get("ptt"):
        return web.json_response({"ok": False, "action": "off", "error": "push-to-talk mode is off"}, status=409)
    now, vs, t = time.time(), voice["state"], turn["t"]
    if request.query.get("dry"):                          # dry run: report what a tap would do, touch nothing
        talking = speech["busy"] or not speech_q.empty() or now < speak_until["t"] or vs == "speaking"
        would = ("stop" if tui["rec"] else "busy" if (talking or vs == "transcribing" or (t and vs == "working"))
                 else "voice_off" if tui["voice_on"] is False else "start")
        ptt_dry.update(n=ptt_dry["n"] + 1, at=now, would=would)
        return web.json_response({"ok": True, "dry": True, "would": would})
    try:
        if tui["rec"]:                                    # recording now: this tap means "I'm done, send it"
            ptt_req.update(id=ptt_req["id"] + 1, at=now, kind="stop")
            await tmux_keys("C-b")
            vlog.info("ptt: stop recording (Ctrl-B)")
            return web.json_response({"ok": True, "action": "stop"})
        talking = speech["busy"] or not speech_q.empty() or now < speak_until["t"] or vs == "speaking"
        if talking or vs == "transcribing" or (t and vs == "working"):
            return web.json_response({"ok": False, "action": "busy", "state": vs}, status=409)
        if ptt_req["kind"] == "start" and now - ptt_req["at"] < ptt_req["window"] + 2 and vs in ("heard", "listening"):
            return web.json_response({"ok": True, "action": "starting"})     # mic is opening; the REC poll catches up in <1 s
        if tui["voice_on"] is False:                      # the TUI's own voice mode is off: Ctrl-B would do nothing
            asyncio.create_task(voice_on_again("ptt"))
            await set_voice("error", "VOICE WAS OFF. TAP SPACE AGAIN")
            return web.json_response({"ok": False, "action": "voice_off"}, status=409)
        armed["until"] = now + 600.0                      # spoken replies allowed: he just asked
        ptt_req.update(id=ptt_req["id"] + 1, at=now, kind="start", window=PTT_WINDOW)
        await set_voice("heard", followup=False, window=PTT_WINDOW)
        await set_crew("alfred", "listening", "LISTENING")
        await tmux_keys("C-b")
        vlog.info("ptt: start listening (Ctrl-B, window %.0fs)", PTT_WINDOW)
        return web.json_response({"ok": True, "action": "start", "window": PTT_WINDOW})
    except Exception as e:
        log.exception("ptt")
        await set_voice("idle")
        return web.json_response({"ok": False, "error": repr(e)[:80]}, status=500)


async def process_speak(agent: str, raw: str, explicit_card, kind: str = "", sid: str = "", said=None,
                        t_recv: float = 0.0):
    try:
        spoken, auto_card = derive_card_and_speech(raw, said)
        card = explicit_card if isinstance(explicit_card, dict) else auto_card
        segs = speech_segments(spoken)
        if said:                                   # already spoken as mid-turn narration: don't read it twice
            kept = [(e, s) for e, s in segs if norm_sentence(s) not in said]
            n_raw = len(speech_segments(derive_card_and_speech(raw)[0]))
            if n_raw > len(kept):
                vlog.info("final answer: narrated sentence(s) skipped (%d -> %d spoken)", n_raw, len(kept))
            if not kept:
                if card:
                    await broadcast({"agent": agent, "state": "idle", "card": card})
                await set_crew(agent, "idle")
                if kind:
                    await end_turn("done")
                return
            segs = kept
        if not segs:
            segs = [(None, "Done.")]
        await set_crew(agent, "thinking", "PREPARING VOICE")
        await enqueue_speech(agent, segs, card=card, kind=kind, sid=sid, t_recv=t_recv)
    except Exception:
        log.exception("speak failed")
        if kind:
            await end_turn("error", "COULDN'T SAY IT. ANSWER IS IN HERMES")
        await set_crew(agent, "idle")
        await broadcast({"agent": agent, "state": "idle"})


async def enqueue_speech(agent, segs, card=None, kind="", sid="", progress=False, t_recv=0.0):
    speech["uid"] += 1
    await speech_q.put({"uid": speech["uid"], "gen": speech["gen"], "agent": agent, "segs": list(segs), "card": card,
                        "kind": kind, "sid": sid, "progress": progress, "t_recv": t_recv or time.time()})


def speech_cancel():
    """Stop: drop everything queued and anything still being synthesized (checked between sentences)."""
    speech["gen"] += 1
    speech["play_end"] = 0.0
    voice["say"] = None
    dropped = 0
    while not speech_q.empty():
        speech_q.get_nowait()
        dropped += 1
    if dropped or speech["busy"]:
        log.info("speech cancelled (%d queued job(s) dropped%s)", dropped, ", in-flight cut" if speech["busy"] else "")


async def speech_worker():
    while True:
        job = await speech_q.get()
        if job["gen"] != speech["gen"]:
            continue
        speech["busy"] = True
        try:
            await run_speech(job)
        except Exception:
            log.exception("speech failed")
            if job["kind"] in ("voice", "result"):
                await end_turn("error", "COULDN'T SAY IT. ANSWER IS IN HERMES")
            await set_crew(job["agent"], "idle")
            await broadcast({"agent": job["agent"], "state": "idle"})
        finally:
            speech["busy"] = False


async def run_speech(job: dict):
    """Synthesize one utterance sentence by sentence. Streaming displays get each sentence the moment it is ready
    (they schedule them back to back); legacy displays get one WAV at the end, exactly as before."""
    loop = asyncio.get_running_loop()
    agent, segs, kind, progress = job["agent"], job["segs"], job["kind"], job["progress"]
    n, uid, t_recv = len(segs), job["uid"], job["t_recv"]
    pcm_all, sr_all, total_dur, first = [], 22050, 0.0, None
    for i, (emo, txt) in enumerate(segs):
        if job["gen"] != speech["gen"]:
            log.info("speech #%d stopped before sentence %d/%d", uid, i + 1, n)
            return
        t0 = time.time()
        pcm, sr = await loop.run_in_executor(synth_pool, synth_pcm, agent, txt)
        if job["gen"] != speech["gen"]:
            log.info("speech #%d stopped during sentence %d/%d", uid, i + 1, n)
            return
        now = time.time()
        dur = len(pcm) / 2.0 / sr
        total_dur += dur
        start = max(speech["play_end"], now + 0.08)       # + decode/schedule latency on the display
        speech["play_end"] = start + dur
        speak_until["t"] = max(speak_until["t"], speech["play_end"] + 1.2)   # wake listener stays deaf until then
        if kind in ("voice", "result"):
            voice["speak_until"] = speech["play_end"]
        if progress:
            voice["say"] = {"text": txt, "until": speech["play_end"]}
        if i == 0:
            first = now - t_recv
            await speech_started(job)
        elif progress:
            await broadcast(voice_public())
        await broadcast({"agent": agent, "state": "speaking", "text": txt, "progress": progress, "emotion": emo,
                         "card": job["card"] if i == 0 else None, "audio": wav_url(pcm, sr),
                         "stream": {"id": uid, "seq": i, "total": n, "final": i == n - 1, "dur": round(dur, 3)}},
                        want="stream")
        log.info("speech #%d %s%s %d/%d synth=%.2fs audio=%.2fs ttfa=%.2fs emotion=%s %r", uid, agent,
                 " (progress)" if progress else "", i + 1, n, now - t0, dur, now - t_recv, emo, snip(txt))
        pcm_all.append(pcm)
        sr_all = sr
    n_stream, n_legacy = client_kinds()
    if n_legacy:
        now = time.time()
        speak_until["t"] = max(speak_until["t"], now + total_dur + 1.2)
        if kind in ("voice", "result"):
            voice["speak_until"] = max(voice["speak_until"], now + total_dur)
        await broadcast({"agent": agent, "state": "speaking", "text": " ".join(s for _, s in segs), "progress": progress,
                         "emotion": segs[0][0], "card": job["card"], "audio": wav_url(b"".join(pcm_all), sr_all)},
                        want="legacy")
    speech["last"] = {"id": uid, "agent": agent, "kind": kind or ("progress" if progress else "other"),
                      "sentences": n, "ttfa": round(first or 0.0, 2), "total": round(time.time() - t_recv, 2),
                      "audio": round(total_dur, 2), "at": round(time.time(), 1)}
    log.info("spoke %s #%d (%d sentence(s), %.1fs audio, first audio after %.2fs, all after %.2fs, card=%s, "
             "displays stream=%d legacy=%d)", agent, uid, n, total_dur, first or 0.0, time.time() - t_recv,
             job["card"]["type"] if job["card"] else None, n_stream, n_legacy)


async def speech_started(job: dict):
    """Side effects of the first sentence going out (what process_speak used to do after its one big WAV)."""
    agent, kind, sid = job["agent"], job["kind"], job["sid"]
    if job["progress"]:
        last_reply.update(kind="progress", at=time.time())
        await broadcast(voice_public())
        return
    state.update(agent=agent, state="speaking", card=job["card"])
    await set_crew(agent, "idle")
    last_reply.update(kind=kind or "other", at=time.time())
    if kind:
        t = turn["t"]
        if t and (not sid or sid == t["session"]):
            turn["t"] = None
        voice["say"] = None
        await set_voice("speaking")


async def handle_event(request: web.Request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    changed = False
    if body.get("theme") in THEMES:
        settings["theme"] = body["theme"]; changed = True
    if isinstance(body.get("tone"), (int, float)) and not isinstance(body.get("tone"), bool):
        settings["tone"] = max(0.0, min(1.0, float(body["tone"]))); changed = True
    if isinstance(body.get("ptt"), bool):
        if settings.get("ptt") != body["ptt"]:
            log.info("push-to-talk mode %s", "ON (wake word ignored, tap Space)" if body["ptt"] else "OFF (wake word)")
        settings["ptt"] = body["ptt"]; changed = True
        await broadcast(voice_public())               # banner copy follows the mode at once
    if changed:
        save_settings()
        await broadcast({"type": "settings", **settings})
        return web.json_response({"ok": True, **settings})
    msg = {"agent": norm_agent(body.get("agent")), "state": body.get("state", "idle")}
    if "card" in body:
        msg["card"] = body["card"]
    await broadcast(msg)
    return web.json_response({"ok": True})


_cals = {}                  # calendar -> its last good event list (a failed fetch keeps the previous one)
dash_state = {"at": 0.0}    # when dash_loop last finished a pass (/health dash_age; doctor.sh checks it)
DASH_EVERY = 30.0


async def dash_tick(loop, last):
    """One dashboard pass: refetch what is due, rebuild weather/agenda/day, broadcast if anything changed."""
    now = time.time()
    if now - _raw["weather_at"] > 900:
        try:
            w = await loop.run_in_executor(None, feeds.get_weather)
            dash["weather"] = dict(w, at=now)            # `at`: the panel says "AS OF 9:15A" once it is old
            _raw["weather_at"] = now
        except Exception as e:
            log.warning("weather fetch failed: %s", e)
            _raw["weather_at"] = now - 780  # retry in ~2 min, keep last data
    if now - _raw["cal_at"] > 600:
        res = await loop.run_in_executor(None, feeds.fetch_calendars)
        new, _raw["events"], failed = feeds.merge_calendars(_cals, res)
        _cals.clear()
        _cals.update(new)
        for cal, err in failed:
            log.warning("calendar %s fetch failed (%s): keeping its %d previous event(s)", cal, err, len(new.get(cal, [])))
        _raw["cal_at"] = now - 480 if failed else now       # retry a failed calendar in ~2 min
    _raw["reminders"] = feeds.load_reminders()
    dash["agenda"] = feeds.build_agenda(_raw["events"], _raw["reminders"], feeds.load_attention())
    try:
        dash["day"] = feeds.day_timeline(_raw["events"], _raw["reminders"])   # v1.1 TODAY window
    except Exception as e:
        log.warning("day timeline failed: %s", e)
    blob = json.dumps(dash, sort_keys=True)
    if blob != last:
        await broadcast(dash)
    return blob


async def dash_loop():
    loop = asyncio.get_running_loop()
    last = None
    while True:
        try:
            last = await dash_tick(loop, last)
            dash_state["at"] = time.time()
        except Exception:
            log.exception("dash loop")      # one bad row or feed must not freeze weather + agenda for good
        try:
            await asyncio.wait_for(refresh_now.wait(), timeout=DASH_EVERY)
            refresh_now.clear()
            _raw["weather_at"] = _raw["cal_at"] = 0.0
        except asyncio.TimeoutError:
            pass


async def start_background(app):
    if DEMO:
        # demo: no tmux voice session, no Hermes. Sample feeds (feeds.py) + a scripted crew so the panel lives.
        import demo
        tasks = [asyncio.create_task(dash_loop()), asyncio.create_task(crew_loop()),
                 asyncio.create_task(speech_worker()), asyncio.create_task(demo.crew_loop(set_crew))]
    else:
        tasks = [asyncio.create_task(dash_loop()), asyncio.create_task(crew_loop()),
                 asyncio.create_task(voice_watch_loop()), asyncio.create_task(voice_loop()),
                 asyncio.create_task(speech_worker()), asyncio.create_task(watch_fail_loop())]
    yield
    for t in tasks:
        t.cancel()


async def handle_attention(request: web.Request):
    """POST {items: ["text", ...]} sets the 'needs attention' list; empty list clears it."""
    try:
        body = await request.json()
        items = [str(x)[:60] for x in body.get("items", [])][:5]
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    feeds.ATTENTION_FILE.write_text(json.dumps(items))
    refresh_now.set()
    return web.json_response({"ok": True, "items": items})


async def handle_refresh(request: web.Request):
    refresh_now.set()
    return web.json_response({"ok": True})


async def handle_ws(request: web.Request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    clients.add(ws)
    ws_builds[id(ws)] = "old"
    await ws.send_str(json.dumps({"type": "settings", **settings}))
    await ws.send_str(json.dumps(dash))
    await ws.send_str(json.dumps(crew_public()))
    await ws.send_str(json.dumps(voice_public()))
    await ws.send_str(json.dumps({"type": "hello", "build": web_build()}))
    log.info("display connected (%d)", len(clients))
    try:
        async for m in ws:
            if m.type == WSMsgType.ERROR:
                break
            if m.type == WSMsgType.TEXT:
                try:
                    d = json.loads(m.data)
                    if d.get("type") == "hello":
                        ws_builds[id(ws)] = str(d.get("build") or "?")[:12]
                        caps = d.get("caps") if isinstance(d.get("caps"), list) else []
                        ws_caps[id(ws)] = {str(c)[:16] for c in caps[:8]}
                except Exception:
                    pass
    finally:
        clients.discard(ws)
        ws_builds.pop(id(ws), None)
        ws_caps.pop(id(ws), None)
        log.info("display disconnected (%d)", len(clients))
    return ws


async def handle_health(request: web.Request):
    now, t, v = time.time(), turn["t"], voice_public()
    v.pop("type", None)
    v["age"] = round(now - voice["since"], 1)
    if t:
        v["turn"]["elapsed"] = round(now - t["started"], 1)
        v["turn"]["beat_age"] = round(now - t["beat"], 1)
        v["turn"]["acks"] = t["acks"]
    return web.json_response({"ok": True, "clients": len(clients), "voices": list(voices),
                              "speaking_for": round(max(0.0, speak_until["t"] - now), 2),
                              "armed_for": round(max(0.0, armed["until"] - now), 1),
                              # wake daemon: open a follow-up mic only after a real voice reply (not "On it.")
                              "followup_ok": last_reply["kind"] in ("voice", "result") and not t
                                             and now - last_reply["at"] < 300,
                              "voice": v, "tui": {k: tui[k] for k in ("seen", "rec", "voice_on", "ready")},
                              "build": web_build(), "client_builds": list(ws_builds.values()),
                              "hook_v4_age": round(now - hook_seen["v4"], 1) if hook_seen["v4"] else None,
                              # seconds since the dashboard loop last finished a pass (None = not yet)
                              "dash_age": round(now - dash_state["at"], 1) if dash_state["at"] else None,
                              "fail": fail_log, "junk": junk_log,
                              "ptt": bool(settings.get("ptt")), "ptt_req": ptt_req, "ptt_seen": ptt_seen, "ptt_dry": ptt_dry,
                              "speech": {"busy": speech["busy"], "queued": speech_q.qsize(),
                                         "stream_clients": client_kinds()[0], "legacy_clients": client_kinds()[1],
                                         "last": speech["last"]}})


async def handle_stop(request: web.Request):
    """Cut any speech in progress on every connected display (tap-to-stop / future voice barge-in)."""
    speak_until["t"] = 0.0
    armed["until"] = 0.0
    state.update(state="idle")
    speech_cancel()
    if turn["t"]:
        turn["t"]["hush"] = True
        if turn["t"].get("stuck") and voice["state"] == "working":     # "STILL TRYING... TAP TO CANCEL"
            await broadcast({"type": "stop", "upto": speech["uid"]})
            await voice_stop("CANCELLED", interrupt=True)
    for a in crew:
        if crew[a]["status"] == "speaking":
            crew_note(a, "idle")
            crew[a] = {"status": "idle", "label": "", "ts": time.time()}
    await broadcast({"type": "stop", "upto": speech["uid"]})
    await broadcast(crew_public())
    if voice["state"] == "speaking":
        await set_voice("done", "STOPPED")
    return web.json_response({"ok": True})


# ----------------------------------------------------------------------- house (v1.1)
# GET /house: read-only status probes for the HOUSE / ALERTS click-in windows. Cached HOUSE_TTL seconds, computed
# in a worker thread. No secrets, nothing written anywhere: gateway_state.json, nightly last-run.json, cron jobs.json,
# wake.log, two localhost HTTP probes, statvfs, `launchctl list` and `pmset -g assertions` (who holds the mic).
HOUSE_TTL = 60.0
house_cache = {"at": 0.0, "data": None}
house_lock = asyncio.Lock()
HOME = Path.home()
GATEWAY_STATE = config.HERMES_HOME / "gateway_state.json"
_AUDIT = config.CFG["house"].get("audit_dir") or ""
NIGHTLY_LAST = config._expand(_AUDIT) / "last-run.json" if _AUDIT else None
NIGHTLY_ALERT = config._expand(_AUDIT) / "ALERT.txt" if _AUDIT else None
HOUSE_SERVICES = [(str(s.get("name", "SERVICE")).upper()[:14], str(s.get("url", "")))
                  for s in (config.CFG["house"].get("services") or []) if isinstance(s, dict) and s.get("url")]


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def _http_code(url: str) -> int:
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "retro-mac-house"}), timeout=2.5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def _tail(path: Path, nbytes: int = 48000) -> list:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - nbytes))
            return f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []


def _launchd() -> dict:
    import subprocess
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return {}
    pids = {}
    for ln in out.splitlines()[1:]:
        p = ln.split("\t")
        if len(p) == 3:
            pids[p[2]] = None if p[0] == "-" else p[0]
    return pids


def _log_ts(line: str):
    try:
        return time.mktime(time.strptime(line[:19], "%Y-%m-%d %H:%M:%S"))
    except Exception:
        return None


def house_snapshot(n_displays: int, ptt_on: bool, tui_state: dict, voice_idle: bool = True) -> dict:
    if DEMO:
        import demo
        return demo.house(n_displays, ptt_on)
    now, svc, alerts = time.time(), [], []
    ld = _launchd()
    # Hermes gateway + its messaging platforms (gateway_state.json)
    try:
        g = json.loads(GATEWAY_STATE.read_text())
    except Exception:
        g = {}
    g_up = g.get("gateway_state") == "running" and _pid_alive(g.get("pid") or 0)
    svc.append({"name": "GATEWAY", "up": g_up, "note": "RUNNING" if g_up else str(g.get("gateway_state") or "NOT RUNNING").upper()})
    for pname, pst in list((g.get("platforms") or {}).items())[:2]:
        p_up = g_up and isinstance(pst, dict) and pst.get("state") == "connected"
        note = "CONNECTED" if p_up else str((pst or {}).get("state") if isinstance(pst, dict) else "OFFLINE").upper()[:14]
        svc.append({"name": str(pname).upper()[:14], "up": p_up, "note": note})
    # local web services from config.toml [house].services (any HTTP answer below 500 = up)
    for name, url in HOUSE_SERVICES:
        code = _http_code(url)
        svc.append({"name": name, "up": 0 < code < 500, "note": f"HTTP {code}" if code else "NO ANSWER"})
    # kiosk + voice + wake
    svc.append({"name": "KIOSK", "up": n_displays > 0, "note": f"{n_displays} DISPLAY" + ("S" if n_displays != 1 else "") if n_displays else "NO DISPLAY"})
    vs_up = bool(ld.get("com.hermes.retro-mac-voice-session"))
    vnote = "READY" if vs_up and tui_state.get("voice_on") is not False else ("VOICE MODE OFF" if vs_up else "NOT RUNNING")
    svc.append({"name": "VOICE", "up": vs_up and tui_state.get("voice_on") is not False, "note": vnote})
    wk_up = bool(ld.get("com.hermes.retro-mac-wake"))
    lines = _tail(config.LOG_DIR / "wake.log")
    mic_line = next((ln for ln in reversed(lines) if " mic opened" in ln or " mic released" in ln), "")
    peak_line = next((ln for ln in reversed(lines) if "mic peak last 20s" in ln), "")
    peak_age = now - (_log_ts(peak_line) or 0) if peak_line else 1e9
    if ptt_on:
        mic_open = " mic opened" in mic_line
        mic = {"ptt": True, "open": mic_open, "note": "MIC OPEN (TALKING)" if mic_open else "MIC CLOSED (IDLE)"}
        wnote = "PTT MODE" if wk_up else "NOT RUNNING"
    else:
        mic = {"ptt": False, "open": peak_age < 90, "note": "WAKE WORD ON, MIC LIVE" if peak_age < 90 else "MIC SILENT"}
        wnote = "LISTENING" if wk_up and peak_age < 90 else ("STALLED" if wk_up else "NOT RUNNING")
    svc.append({"name": "WAKE / MIC", "up": wk_up and (ptt_on or peak_age < 90), "note": wnote})
    # The logs above say what the wake daemon meant to do; CoreAudio says who really has the mic open (macOS only).
    # Voice idle -> nobody should hold it, except the wake daemon itself while the wake word is on.
    if voice_idle and (not ptt_on or not mic["open"]):
        held = micprobe.mic_holders(exclude=() if ptt_on else (ld.get("com.hermes.retro-mac-wake") or "",))
        if held:
            pid = held[0]["pid"]
            mic.update(open=True, held_by=pid, held_for=held[0]["for"], note=f"MIC HELD BY PID {pid}")
            alerts.append(f"MIC HELD BY PID {pid} ({held[0]['for']}) WHILE VOICE IS IDLE")
    # disk (data volume)
    disk = None
    try:
        st = os.statvfs(str(HOME))
        total, free = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
        disk = {"free_gb": round(free / 1e9, 1), "total_gb": round(total / 1e9), "pct_free": round(100 * free / total)}
        if disk["pct_free"] < 10:
            alerts.append(f"DISK LOW: {disk['free_gb']} GB FREE ({disk['pct_free']}%)")
    except Exception:
        pass
    # nightly audit
    audit = None
    try:
        if not NIGHTLY_LAST:
            raise FileNotFoundError("no [house].audit_dir configured")
        a = json.loads(NIGHTLY_LAST.read_text())
        first = str(a.get("summary") or "").splitlines()[0] if a.get("summary") else ""
        line = first.split(": ", 1)[1] if ": " in first else first
        audit = {"at": a.get("finished"), "ok": bool(a.get("ok")), "sev": str(a.get("severity_max") or "").upper(),
                 "line": line.rstrip(".").upper()[:70], "alert": NIGHTLY_ALERT.exists()}
        if audit["alert"]:
            alerts.append("NIGHTLY AUDIT: SEVERE FINDING, SEE REPORT")
        elif not audit["ok"]:
            alerts.append("NIGHTLY AUDIT DID NOT FINISH CLEANLY")
    except Exception:
        pass
    # cron jobs: next run + today's runs
    jobs, nxt = [], None
    try:
        d = json.loads(feeds.CRON_JOBS.read_text())
        today = time.strftime("%Y-%m-%d")
        from datetime import datetime as _dt
        for j in (d["jobs"] if isinstance(d, dict) else d):
            if not j.get("enabled"):
                continue
            name = str(j.get("name") or "JOB").upper()[:30]
            na, la = j.get("next_run_at"), j.get("last_run_at")
            if na:
                ts = _dt.fromisoformat(na).timestamp()
                if ts > now and (not nxt or ts < nxt["ts"]):
                    nxt = {"name": name, "ts": ts}
                if ts > now and time.strftime("%Y-%m-%d", time.localtime(ts)) == today:
                    jobs.append({"ts": ts, "name": name, "st": "LATER"})
            if la:
                ts = _dt.fromisoformat(la).timestamp()
                if time.strftime("%Y-%m-%d", time.localtime(ts)) == today:
                    bad = str(j.get("last_status") or "ok").lower() not in ("ok", "success", "")
                    jobs.append({"ts": ts, "name": name, "st": "FAIL" if bad else "DONE"})
        jobs.sort(key=lambda x: x["ts"])
        for x in jobs:
            if x["st"] == "LATER":
                x["st"] = "NEXT"
                break
    except Exception:
        pass
    for s in svc:
        if not s["up"]:
            alerts.append(f"{s['name']} IS DOWN ({s['note']})")
    try:
        att_since = feeds.ATTENTION_FILE.stat().st_mtime
    except OSError:
        att_since = None
    return {"ok": True, "at": now, "services": svc, "mic": mic, "disk": disk, "audit": audit,
            "next_job": nxt, "jobs": jobs[-8:], "alerts": alerts,
            "attention": [{"t": t, "since": att_since} for t in feeds.load_attention()]}


async def handle_house(request: web.Request):
    async with house_lock:
        if not house_cache["data"] or time.time() - house_cache["at"] > HOUSE_TTL or "fresh" in request.query:
            loop = asyncio.get_running_loop()
            try:
                house_cache["data"] = await loop.run_in_executor(
                    None, house_snapshot, len(clients), bool(settings.get("ptt")), dict(tui),
                    voice["state"] in ("idle", "done") and not turn["t"])
                house_cache["at"] = time.time()
            except Exception as e:
                log.exception("house snapshot")
                return web.json_response({"ok": False, "error": str(e)[:80]}, status=500)
    return web.json_response(house_cache["data"], headers={"Cache-Control": "no-store"})


async def handle_index(request: web.Request):
    return web.FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


def make_app() -> web.Application:
    app = web.Application(client_max_size=1024 * 64, middlewares=[guard])
    app.router.add_get("/", handle_index)
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/house", handle_house)
    app.router.add_post("/speak", handle_speak)
    app.router.add_post("/event", handle_event)
    app.router.add_post("/attention", handle_attention)
    app.router.add_post("/activity", handle_activity)
    app.router.add_post("/stop", handle_stop)
    app.router.add_post("/arm", handle_arm)
    app.router.add_post("/disarm", handle_disarm)
    app.router.add_post("/ptt", handle_ptt)
    app.router.add_post("/ptt_seen", handle_ptt_seen)
    app.router.add_post("/refresh", handle_refresh)
    app.router.add_route("*", "/voice_state", handle_voice_state)
    app.router.add_post("/voice_turn", handle_voice_turn)
    app.router.add_post("/voice_error", handle_voice_error)
    app.router.add_post("/voice_junk", handle_voice_junk)
    app.router.add_post("/level", handle_level)
    app.router.add_post("/voice_pending", handle_voice_pending)
    app.cleanup_ctx.append(start_background)
    app.router.add_static("/", WEB, show_index=False)
    return app


# ---------------------------------------------------------------------- logging
# data/logs/server.log rotates at 2 MB x 3 (launchd never rotates). start.sh / launchd send raw stdout+stderr
# (startup crashes only) to server.out, so nothing else holds server.log open across a rotation.
LOG_FILE = config.LOG_DIR / "server.log"
QUIET_PATHS = ('"GET /health', '"POST /level', '"POST /activity', '"GET /house')   # polled every few seconds


class QuietAccess(logging.Filter):
    def filter(self, rec):
        m = rec.getMessage()
        return not any(q in m for q in QUIET_PATHS)


def setup_logging(console=None, log_file=None):
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fh = logging.handlers.RotatingFileHandler(log_file or LOG_FILE, maxBytes=2 * 1024 * 1024, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    if console if console is not None else sys.stderr.isatty():     # ./start.sh --fg: also to the terminal
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        root.addHandler(sh)
    logging.getLogger("aiohttp.access").addFilter(QuietAccess())
    return fh


if __name__ == "__main__":
    setup_logging()
    load_settings()
    load_voices()
    web.run_app(make_app(), host=HOST, port=PORT, print=lambda *_: log.info("http://%s:%d", HOST, PORT))
