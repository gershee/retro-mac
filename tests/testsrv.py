#!/usr/bin/env python3
"""Silent test instance of the Retro Mac server on another port (default 8791).

No kiosk is attached to it, the tmux voice-session poller and the weather/calendar feeds are off and
settings.json is never written, so POST /speak etc. can be exercised without making a real kiosk talk.

  venv/bin/python tests/testsrv.py [path/to/server.py] [port]
"""
import importlib.util
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "server" / "server.py"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8791
os.environ["RETRO_MAC_PORT"] = str(port)
sys.argv = sys.argv[:1]                 # config.py looks for --demo in argv
sys.path.insert(0, str(src.resolve().parent))   # config.py, feeds.py, demo.py
spec = importlib.util.spec_from_file_location("server_under_test", src)
s = importlib.util.module_from_spec(spec)
sys.modules["server_under_test"] = s
spec.loader.exec_module(s)

s.PORT = port
s.WEB = Path(os.environ.get("KIOSK2_WEB") or ROOT / "web")   # staged web files (not yet live)


async def _idle():
    import asyncio
    while True:
        await asyncio.sleep(3600)

s.voice_watch_loop = _idle     # never touch a real hermes-voice tmux session
s.dash_loop = _idle            # no network feeds
# The fail watcher reads the "voice pane" through s.pane_text: serve a fake pane from $FAKE_PANE (a text file the
# test appends error text to) and never touch a real tmux session.
async def _fake_pane(history=400):
    f = os.environ.get("FAKE_PANE")
    try:
        return Path(f).read_text() if f else ""
    except OSError:
        return ""
s.pane_text = _fake_pane
# Fake hermes-voice TUI: Ctrl-B toggles "recording" (what the real TUI does), keys are logged to s.fake_keys and
# served at GET /_keys; a tiny loop mirrors voice_watch_loop's REC edges (listening -> transcribing). A real tmux
# session is never touched. Opt in with FAKE_TUI=1; FAKE_VOICE_OFF=1 to simulate the TUI's voice mode being off.
s.fake_keys = []
async def _fake_tmux_keys(*keys, literal=False):
    s.fake_keys.append(" ".join(keys))
    if keys == ("C-b",):
        s.tui["rec"] = not s.tui["rec"]
s.tmux_keys = _fake_tmux_keys
async def _fake_watch():
    import asyncio
    rec = False
    s.tui.update(seen=True, ready=True, voice_on=False if os.environ.get("FAKE_VOICE_OFF") else True)
    while True:
        await asyncio.sleep(0.2)
        now = s.tui["rec"]
        if now and not rec:
            s.voice["rec_start"] = __import__("time").time()
            await s.set_crew("alfred", "listening", "LISTENING")
            if s.voice["state"] != "listening":
                await s.set_voice("listening", followup=False, window=s.voice["window"] if s.voice["state"] == "heard" else 0.0)
        elif rec and not now:
            s.voice["rec_end"] = __import__("time").time()
            if s.voice["state"] in ("listening", "heard"):
                await s.set_voice("transcribing")
        rec = now
if os.environ.get("FAKE_TUI"):          # opt-in: other tests keep the idle watcher (tui state unknown)
    s.voice_watch_loop = _fake_watch
from aiohttp import web as _w  # noqa: E402
_make_app = s.make_app
def _app():
    app = _make_app()
    async def keys(request):
        return _w.json_response({"keys": s.fake_keys, "rec": s.tui["rec"]})
    app.router.add_get("/_keys", keys)
    return app
s.make_app = _app
s.save_settings = lambda: None
s.SETTINGS_FILE = Path("/dev/null")

logging.basicConfig(level=logging.INFO, format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s", datefmt="%H:%M:%S")
s.load_voices()
logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
from aiohttp import web  # noqa: E402
web.run_app(s.make_app(), host="127.0.0.1", port=port, print=lambda *_: logging.info("test server on %d (%s)", port, src))
