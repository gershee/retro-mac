"""Retro Mac face hook (v0.6).

v0.6: junk voice transcripts ("[BLANK_AUDIO]", "(inaudible)", a lone "you" ...; see junk.py) are blocked in
pre_llm_call ({"action":"block","message":"[SILENT]"}: no model call, nothing spoken) and reported to /voice_junk.

v0.5 (voice turns only): on_interim_message -> /speak voice=progress (the model's own "Checking your calendar."
narration before / between tool calls is spoken right away); pre/post_tool_call send a human caption + step
start/done for the banner checklist; voice rules ask for narration and optional [happy]-style tone tags.

Jobs, all fire-and-forget on one daemon worker thread so they can never slow down or break the
agent / Telegram delivery (every failure is swallowed):

1. post_llm_call  -> POST {agent, text} to /speak     (the face speaks the reply)
2. pre_llm_call / pre_tool_call -> POST {agent, status, label, session_id} to /activity
   (the crew panel shows who is thinking / working on what, even when nobody is speaking)
3. Voice turns (v0.4): pre_transcription(source=voice_mode) marks "the user just spoke"; the next local
   turn's pre_llm_call asks the server (POST /voice_turn, 0.5s cap, the only synchronous call) whether
   it is a voice-originated turn. Voice turns get the kiosk voice rules injected as turn context
   (background long jobs, short spoken answers) and their reply is sent as /speak voice=voice; the
   background-job completion turn in the same session is voice=result (spoken even after the 600s
   armed window lapsed). Background launches inside a voice turn register /voice_pending.

Agent identity: every `hermes -p <profile> chat/-z` run is a thin client; the turn itself runs
inside the ONE multiplexed gateway process, whose os.environ HERMES_HOME is the default home.
Hermes loads a separate copy of this module per profile home and runs hooks under a
context-local home override, so the agent id must come from hermes_constants.get_hermes_home()
(context-aware), never from os.environ (which always says "alfred" inside the gateway).
Only short verbs and file basenames are sent as labels, never command text or file contents.
"""
import json
import os
import queue
import threading
import time
import urllib.request
from pathlib import Path

BASE = os.environ.get("RETRO_MAC_BASE", "http://127.0.0.1:8787")
AGENTS = {"alfred", "scout", "maker"}
CHAT_PLATFORMS = ("telegram", "discord", "cron", "webhook", "slack", "email", "sms")
REVIEW_PREFIXES = ("Review the conversation above",)
# Who is talking to the kiosk, as the model should hear it ("Sam", "the user", ...).
USER = os.environ.get("RETRO_MAC_USER_NAME", "The user")
# Optional: how long jobs should be handed off (your own delegate script, a subagent tool...). Shown to the model.
DELEGATE_HINT = os.environ.get("RETRO_MAC_DELEGATE_HINT", "")

VOICE_RULES = (
    f"[Retro Mac voice ask: {USER} said this OUT LOUD to the kiosk and your reply will be read aloud. "
    "Keep the spoken answer to 1-3 short sentences; put details in a short list (it shows on screen). "
    "TALK WHILE YOU WORK: before your FIRST tool call, write one short sentence saying what you are doing "
    "(e.g. \"Checking your calendar.\"); between tool steps add one short update when the next step changes "
    "(\"Found it, now checking traffic.\"). Each is spoken right away, so never go quiet for more than a few "
    "seconds, never repeat an update in the final answer, and keep updates under 12 words. No tools needed: "
    "just answer. "
    "If what was said is ONLY a transcription artifact or noise (a tag like [BLANK_AUDIO] / [SOUND] / (inaudible), "
    "a lone filler word, or empty), reply with exactly [SILENT] and nothing else; real but unclear speech still "
    "gets a normal short answer. "
    "TONE TAGS: you may start a sentence with one of [happy] [thinking] [surprised] [curious] [concerned] "
    "[sleepy]; the kiosk face shows it and the tag is not spoken. Use them sparingly, no other tags. "
    "If answering will clearly take more than ~30 seconds (research, data analysis, multi-step builds, long "
    "scripts), do NOT do it inline, because the voice session is deaf while you work: start it in the "
    "background right away (terminal with background=true and notify=true running the long command"
    + (f", or {DELEGATE_HINT}" if DELEGATE_HINT else "") +
    ") and reply only: \"On it. I'll tell you when it's done.\" When the "
    "background-completion message arrives, give the result in 1-3 spoken sentences; the kiosk speaks it.]"
)
RESULT_RULES = (f"[Retro Mac: {USER} asked for this job by voice. Give the result in 1-3 short spoken "
                "sentences, details as a short list. It will be read aloud.]")
CANCEL_RULES = (f"[Retro Mac voice: {USER} said cancel / never mind. Whatever was running was interrupted. "
                "Do not start anything. Reply with one word: Stopped.]")

try:   # shared with server.py; loaded by path so it works for every symlinked copy of this plugin
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("retro_mac_junk", Path(__file__).with_name("junk.py"))
    _jm = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_jm)
    _is_junk = _jm.is_junk
except Exception:
    _is_junk = None   # no local filter; the server's /voice_turn still classifies junk

_q: "queue.Queue[tuple]" = queue.Queue(maxsize=64)
_worker_lock = threading.Lock()
_worker = None
_home_agent = {"id": None}   # agent of the profile home this module copy was registered under
_voice_mark = {"t": 0.0}     # last pre_transcription(source=voice_mode) in this process
_kinds: dict = {}            # session_id -> voice | result | cancel | quiet (turns the server classified)


def _agent_from_home(home) -> str:
    home = Path(home)
    if home.parent.name == "profiles" and home.name.lower() in AGENTS:
        return home.name.lower()
    return "alfred"  # default profile is Alfred


def _current_home():
    try:
        from hermes_constants import get_hermes_home  # context-local override first, then env
        return get_hermes_home()
    except Exception:
        return os.environ.get("HERMES_HOME") or Path.home() / ".hermes"


def _agent_id() -> str:
    try:
        agent = _agent_from_home(_current_home())
    except Exception:
        agent = "alfred"
    if agent == "alfred" and _home_agent["id"] not in (None, "alfred"):
        return _home_agent["id"]   # context lost (bare thread): trust the home we were loaded for
    return agent


def _post(path: str, body: dict, timeout: float = 2.0):
    try:
        req = urllib.request.Request(
            BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"}
        )
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read() or b"{}")
    except Exception:
        return None  # display is optional


# per (agent, session): last real event + last heartbeat (keyed by session so Alfred's Telegram turn and
# his voice turn never clobber each other's state)
_cur: dict = {}
HEARTBEAT = 15.0
STALE_AFTER = 20 * 60   # an "active" turn with no event for this long is treated as dead


def _state(key) -> dict:
    return _cur.setdefault(key, {"status": "idle", "label": "", "at": 0.0, "hb": 0.0})


def _run() -> None:
    while True:
        try:
            path, body = _q.get(timeout=5)
        except queue.Empty:
            # One long model/tool call emits no events; without a heartbeat the display would drop a busy
            # agent from the crew panel (2 min) and declare a voice turn lost (3 min) mid-thought.
            now = time.time()
            for (agent, sid), st in list(_cur.items()):
                if (st["status"] in ("thinking", "working") and now - st["at"] < STALE_AFTER
                        and now - max(st["at"], st["hb"]) >= HEARTBEAT):
                    st["hb"] = now
                    _post("/activity", {"agent": agent, "status": st["status"], "label": st["label"],
                                        "session_id": sid})
            continue
        key = (body.get("agent", "alfred"), body.get("session_id") or "")
        st = _state(key)
        if path == "/activity":
            st.update(status=body.get("status", "idle"), label=body.get("label", ""), at=time.time())
        elif path == "/voice_state" or (path == "/speak" and body.get("voice") != "progress"):
            st.update(status="idle", label="", at=time.time())   # narration mid-turn keeps the heartbeat going
        _post(path, body)


def _send(path: str, body: dict) -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, daemon=True, name="retro-mac-face")
            _worker.start()
    try:
        _q.put_nowait((path, body))
    except queue.Full:
        pass


# --------------------------------------------------------------------- activity
_VERBS = (  # (substring of tool name, label); first match wins
    ("write_file", "CODING"), ("patch", "CODING"), ("skill_manage", "CODING"),
    ("read_file", "READING"), ("search_files", "READING"),
    ("web_search", "SEARCHING"), ("web_extract", "SEARCHING"), ("smart_search", "SEARCHING"),
    ("smart_fetch", "SEARCHING"), ("smart_crawl", "SEARCHING"), ("scrape", "SEARCHING"),
    ("browser", "BROWSING"), ("chrome", "BROWSING"), ("unbrowse", "BROWSING"),
    ("delegate_task", "DELEGATING"), ("execute_code", "RUNNING CODE"),
    ("terminal", "RUNNING TERMINAL"), ("process_manage", "RUNNING"),
    ("skill", "LOADING SKILL"), ("memory", "REMEMBERING"), ("fact_", "REMEMBERING"),
    ("vision", "LOOKING"), ("cronjob", "SCHEDULING"), ("todo", "PLANNING"),
    ("text_to_speech", "SPEAKING"), ("clarify", "ASKING"), ("computer_use", "DRIVING MAC"),
)


def _label(tool_name: str, args) -> str:
    name = (tool_name or "").lower()
    label = "WORKING"
    for key, verb in _VERBS:
        if key in name:
            label = verb
            break
    if label == "RUNNING TERMINAL" and isinstance(args, dict):   # who is being asked, never the command
        cmd = str(args.get("command") or "")
        if "ask-team scout" in cmd:
            return "ASKING SCOUT"
        if "ask-team maker" in cmd:
            return "ASKING MAKER"
    if label == "CODING" and isinstance(args, dict):  # file names only for writes; reads stay generic
        p = args.get("path") or args.get("file_path") or ""
        if isinstance(p, str) and p:
            return f"{label} {os.path.basename(p)}"[:28]
    return label


_last: dict = {}   # (agent, session) -> (label, at)


# ---------------------------------------------------------------- step captions (voice turns only)
# Tool call -> (on-screen caption, spoken fallback line). The caption goes to the banner checklist; the line is
# what the server says at ~8s if the model itself narrated nothing ("Looking that up." instead of "On it.").
# Only short words, a search query, a file basename or a web domain ever leave here; never command text.
_CAPS = (  # (substring of tool name, caption, line); first match wins
    ("tool_search", "FINDING A TOOL", "One second."), ("tool_describe", "FINDING A TOOL", "One second."),
    ("calendar", "CHECKING YOUR CALENDAR", "Checking your calendar."),
    ("gmail", "CHECKING EMAIL", "Checking your email."), ("mail", "CHECKING EMAIL", "Checking your email."),
    ("weather", "CHECKING THE WEATHER", "Checking the weather."),
    ("spotify", "MUSIC", "One second."), ("hue", "LIGHTS", "One second."),
    ("web_search", "SEARCHING", "Looking that up."), ("smart_search", "SEARCHING", "Looking that up."),
    ("web_extract", "READING", "Reading that page."), ("smart_fetch", "READING", "Reading that page."),
    ("smart_crawl", "READING", "Reading that page."), ("scrape", "READING", "Reading that page."),
    ("read_file", "READING", "Reading that now."), ("search_files", "SEARCHING FILES", "Looking through the files."),
    ("write_file", "EDITING", "Making the change."), ("patch", "EDITING", "Making the change."),
    ("browser", "BROWSING", "Checking the web."), ("chrome", "BROWSING", "Checking the web."),
    ("delegate_task", "ASKING A HELPER", "Getting help with that."),
    ("execute_code", "RUNNING CODE", "Running that now."), ("terminal", "RUNNING A COMMAND", "Running that now."),
    ("process", "CHECKING A JOB", "Checking on that."),
    ("skill", "LOADING A SKILL", "One second."), ("memory", "CHECKING MEMORY", "One second."),
    ("fact_", "CHECKING MEMORY", "One second."), ("vision", "LOOKING AT THE IMAGE", "Taking a look."),
    ("cronjob", "SCHEDULING", "Setting that up."), ("todo", "PLANNING", "One second."),
    ("send_message", "SENDING A MESSAGE", "Sending that."), ("clarify", "ASKING YOU", ""),
    ("computer_use", "DRIVING THE MAC", "On it."), ("text_to_speech", "SPEAKING", ""),
)
_CMD_HINTS = (  # terminal: which helper / service a command talks to (keywords only)
    ("ask-team scout", "ASKING SCOUT", "Asking Scout."), ("ask-team maker", "ASKING MAKER", "Asking Maker."),
    ("gcal", "CHECKING YOUR CALENDAR", "Checking your calendar."), ("calendar", "CHECKING YOUR CALENDAR", "Checking your calendar."),
    ("gmail", "CHECKING EMAIL", "Checking your email."), ("himalaya", "CHECKING EMAIL", "Checking your email."),
    ("weather", "CHECKING THE WEATHER", "Checking the weather."), ("curl ", "FETCHING DATA", "Fetching that."),
)


def _short(s, n=26) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 2].rstrip() + ".."


def _domain(url) -> str:
    try:
        from urllib.parse import urlparse
        return (urlparse(str(url)).hostname or "").removeprefix("www.")
    except Exception:
        return ""


def _caption(tool_name: str, args) -> tuple:
    name = (tool_name or "").lower()
    args = args if isinstance(args, dict) else {}
    if name == "tool_call":                       # deferred tools: caption the first real call inside
        calls = args.get("calls")
        if isinstance(calls, list) and calls and isinstance(calls[0], dict):
            return _caption(str(calls[0].get("name") or ""), calls[0].get("arguments"))
    cap, line = "WORKING", "On it."
    for key, c, l in _CAPS:
        if key in name:
            cap, line = c, l
            break
    if cap == "RUNNING A COMMAND":
        cmd = str(args.get("command") or "").lower()
        for key, c, l in _CMD_HINTS:
            if key in cmd:
                return c, l
    elif cap == "SEARCHING":
        q = args.get("query") or args.get("q") or ""
        if q:
            return f"SEARCHING: {_short(q, 30)}", line
    elif cap in ("READING", "EDITING", "BROWSING"):
        p = args.get("path") or args.get("file_path") or ""
        urls = args.get("urls")
        url = args.get("url") or (urls[0] if isinstance(urls, list) and urls else "")
        if isinstance(p, str) and p:
            return f"{cap} {_short(os.path.basename(p), 28)}", line
        d = _domain(url) if isinstance(url, str) and url else ""
        if d:
            return f"{cap} {_short(d, 28)}", line
    elif cap == "LOADING A SKILL" and args.get("name"):
        return f"SKILL: {_short(args.get('name'), 28)}", line
    return cap, line


def _activity(status: str, label: str, sid: str = "") -> None:
    agent = _agent_id()
    now = time.time()
    # collapse bursts of identical labels, but still refresh at least every 4s (keeps it alive)
    prev = _last.get((agent, sid))
    if prev and label == prev[0] and now - prev[1] < 4:
        return
    _last[(agent, sid)] = (label, now)
    _send("/activity", {"agent": agent, "status": status, "label": label, "session_id": sid})


def _sid(kwargs) -> str:
    return str(kwargs.get("session_id") or "")


def _junk_block(sid: str, msg: str):
    """A voice turn whose transcript is noise: tell the display (quiet DIDN'T CATCH THAT), skip the model."""
    _voice_mark["t"] = 0.0
    _kinds.pop(sid, None)
    _send("/voice_junk", {"agent": _agent_id(), "session_id": sid, "text": msg[:80]})
    _send("/activity", {"agent": _agent_id(), "status": "idle", "label": "", "session_id": sid})
    return {"action": "block", "message": "[SILENT]"}   # no inference request; "[SILENT]" is never spoken


def _on_pre_llm_call(**kwargs):
    sid = _sid(kwargs)
    platform = str(kwargs.get("platform") or "").lower()
    msg = kwargs.get("user_message")
    try:   # junk first: no THINKING flash, no model call, no spoken reply
        if (_is_junk is not None and isinstance(msg, str) and platform not in CHAT_PLATFORMS
                and time.time() - _voice_mark["t"] < 120 and _is_junk(msg)
                and not msg.lstrip().startswith(("[IMPORTANT", "[Background", "[ASYNC", "[Retro Mac"))):
            return _junk_block(sid, msg)
    except Exception:
        pass
    _activity("thinking", "THINKING", sid)
    if platform in CHAT_PLATFORMS or not isinstance(msg, str):
        return None
    try:
        marker = time.time() - _voice_mark["t"] < 120
        r = _post("/voice_turn", {"agent": _agent_id(), "session_id": sid, "platform": platform,
                                  "text": msg[:600], "marker": marker}, timeout=0.5) or {}
        kind = r.get("kind") or "none"
        if kind == "junk":                  # the server's filter caught what the local one missed
            return _junk_block(sid, msg)
        if kind in ("voice", "cancel"):
            _voice_mark["t"] = 0.0          # one recording = one voice turn
        if kind == "none":
            _kinds.pop(sid, None)
            return None
        _kinds[sid] = kind
        rules = {"voice": VOICE_RULES, "result": RESULT_RULES, "cancel": CANCEL_RULES}.get(kind)
        return {"context": rules} if rules else None
    except Exception:
        return None


def _on_pre_tool_call(**kwargs):
    sid = _sid(kwargs)
    label = _label(kwargs.get("tool_name"), kwargs.get("args"))
    try:
        if _kinds.get(sid) == "voice":            # voice turn: caption for the banner's step checklist
            cap, line = _caption(kwargs.get("tool_name"), kwargs.get("args"))
            agent = _agent_id()
            _last[(agent, sid)] = (label, time.time())
            _send("/activity", {"agent": agent, "status": "working", "label": label, "session_id": sid,
                                "caption": cap, "say": line, "step": "start",
                                "call_id": str(kwargs.get("tool_call_id") or "")})
            return None
    except Exception:
        pass
    _activity("working", label, sid)
    return None


def _on_interim_message(**kwargs):
    """Assistant text that precedes tool calls in a turn (agent/stream_delivery._emit_interim_assistant_message,
    fired after the assistant row is saved and BEFORE its tools run). In a voice turn it is the model's own
    narration ("Checking your calendar."), so it is spoken right away as /speak voice=progress."""
    try:
        sid = _sid(kwargs)
        text = kwargs.get("text")
        if _kinds.get(sid) != "voice" or not isinstance(text, str) or not text.strip():
            return None
        if text.strip().upper().startswith("[SILENT]"):
            return None
        _send("/speak", {"agent": _agent_id(), "text": text.strip()[:1200], "session_id": sid, "voice": "progress"})
    except Exception:
        pass
    return None


def _on_pre_transcription(**kwargs):
    # Voice input just finished recording and is being turned into text: show it immediately.
    if str(kwargs.get("source") or "") == "voice_mode":
        _voice_mark["t"] = time.time()
    _activity("thinking", "HEARD YOU")
    return None


def _on_post_tool_call(**kwargs):
    sid = _sid(kwargs)
    if _kinds.get(sid) == "voice":                # tick the step off in the banner checklist
        agent = _agent_id()
        _last[(agent, sid)] = ("THINKING", time.time())
        _send("/activity", {"agent": agent, "status": "thinking", "label": "THINKING", "session_id": sid,
                            "step": "done", "call_id": str(kwargs.get("tool_call_id") or "")})
    else:
        _activity("thinking", "THINKING", sid)  # tool done; the model is reading the result
    try:
        if _kinds.get(sid) == "voice":
            name = str(kwargs.get("tool_name") or "").lower()
            res = str(kwargs.get("result") or "")[:4000]
            args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
            started = ((name == "terminal" and args.get("background") and "Background process started" in res)
                       or (name == "delegate_task" and ('"mode": "background"' in res or '"dispatched"' in res)))
            if started:
                cmd = str(args.get("command") or "")
                label = ("SCOUT RESEARCH" if "ask-team scout" in cmd else "MAKER BUILD" if "ask-team maker" in cmd
                         else "SUBAGENT" if name == "delegate_task" else "BACKGROUND JOB")
                _send("/voice_pending", {"op": "add", "label": label, "session_id": sid, "agent": _agent_id()})
    except Exception:
        pass
    return None


def _on_post_llm_call(**kwargs):
    agent = _agent_id()
    sid = _sid(kwargs)
    kind = _kinds.pop(sid, None)
    text = kwargs.get("assistant_response")
    _last.pop((agent, sid), None)
    um = kwargs.get("user_message")
    if not isinstance(text, str):
        if kind in ("voice", "result", "cancel"):
            _send("/voice_state", {"state": "done", "session_id": sid, "agent": agent})
        return None
    text = text.strip()
    review = isinstance(um, str) and um.startswith(REVIEW_PREFIXES)
    # Work Alfred hands to Scout/Maker via ask-team is never read aloud by them (Alfred relays the result,
    # and Telegram-started handoffs must stay silent). The crew panel still shows them working.
    delegated = isinstance(um, str) and um.lstrip().startswith("[Delegated by Alfred")
    if not text or text.upper().startswith("[SILENT]") or review or kind == "quiet" or (delegated and kind not in ("voice", "result", "cancel")):
        _send("/activity", {"agent": agent, "status": "idle", "label": "", "session_id": sid})
        if kind in ("voice", "result", "cancel"):
            _send("/voice_state", {"state": "done", "session_id": sid, "agent": agent})
        return None
    if str(kwargs.get("platform") or "").lower() in CHAT_PLATFORMS:
        # Replies to chat apps / scheduled jobs are never spoken aloud; only voice/kiosk/CLI-initiated turns are.
        _send("/activity", {"agent": agent, "status": "idle", "label": "", "session_id": sid})
        return None
    body = {"agent": agent, "text": text, "session_id": sid}
    if kind in ("voice", "result", "cancel"):
        body["voice"] = "result" if kind == "result" else "voice"
    _send("/speak", body)
    return None


def register(ctx) -> None:
    # register() runs inside the plugin manager's home scope, so this is the profile we serve.
    try:
        _home_agent["id"] = _agent_from_home(_current_home())
    except Exception:
        pass
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("pre_transcription", _on_pre_transcription)
    try:
        ctx.register_hook("on_interim_message", _on_interim_message)   # observer; older Hermes: skipped
    except Exception:
        pass
