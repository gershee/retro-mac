"""Retro Mac configuration.

Order (later wins): built-in defaults -> config.toml (repo root, or $RETRO_MAC_CONFIG) -> environment variables.
Nothing personal lives in the code: location, calendars and house probes all come from config.toml.
Copy config.example.toml to config.toml to start. `--demo` / RETRO_MAC_DEMO=1 ignores every external
source and shows built-in sample data, so the kiosk runs on any machine with no Hermes and no Google account.
"""
import os
import sys
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

ROOT = Path(__file__).resolve().parent.parent          # repo root
WEB = ROOT / "web"
PLUGIN_DIR = ROOT / "hermes-plugin" / "retro_mac_face"


def _expand(p) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p))))


def _local_tz_name() -> str:
    if os.environ.get("TZ"):
        return os.environ["TZ"]
    try:  # macOS / most Linux: /etc/localtime -> .../zoneinfo/Area/City
        target = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in target:
            return target.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    return "UTC"


DEFAULTS = {
    "server": {"port": 8787, "demo": False},
    "location": {
        # Shown as the WEATHER panel title. Pick your own in config.toml; this is just a placeholder.
        "name": "SAN FRANCISCO",
        "latitude": 37.7749,
        "longitude": -122.4194,
        "timezone": "",            # "" = this machine's local time zone
    },
    "calendar": {
        # A command that prints a JSON list of events for one calendar between {start} and {end} (ISO 8601):
        #   [{"summary": "...", "start": "2026-01-01T09:00:00-05:00", "end": "...", "status": "confirmed"}, ...]
        # All-day events use plain dates ("2026-01-01"). Empty = no calendar (the TODAY panel still shows reminders).
        "command": [],
        "calendars": ["primary"],
    },
    "hermes": {
        "home": "~/.hermes",       # one-shot cron reminders (cron/jobs.json) + gateway state for the HOUSE window
        "voice_session": "hermes-voice",   # tmux session that runs `hermes --tui` with voice mode on
    },
    "house": {
        # Extra local web services probed by the HOUSE window: [{name = "NAS", url = "http://127.0.0.1:5000/"}]
        "services": [],
        # Optional directory with a nightly audit's last-run.json / ALERT.txt (leave empty to hide the row)
        "audit_dir": "",
    },
    "limits": {
        # Optional LIMITS window (key 6): Claude subscription usage, read through Hermes (signed in to Claude).
        # The Hermes venv python that runs scripts/usage_probe.py, e.g. "~/.hermes/hermes-agent/venv/bin/python".
        # "" = the window says NOT CONFIGURED.
        "python": "",
        "provider": "anthropic",
    },
    "voices": {
        "dir": "voices",
        "alfred": "en_GB-alan-medium.onnx",
        "scout": "en_US-amy-medium.onnx",
        "maker": "en_US-joe-medium.onnx",
    },
    "aol": {
        # Your name on the optional AOL skin (theme "aol", key T): the "Welcome, <name>!" window, buddy list, IMs.
        # 3-16 letters / digits / spaces. Env RETRO_MAC_SCREEN_NAME overrides.
        "screen_name": "guest",
    },
}


def clean_screen_name(v, default: str = "guest") -> str:
    """Screen names are 3-16 chars of letters, digits and spaces; anything else falls back to the default."""
    s = " ".join("".join(c for c in str(v or "") if c.isascii() and (c.isalnum() or c == " ")).split())[:16].strip()
    return s if len(s) >= 3 else default


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def load() -> dict:
    cfg = DEFAULTS
    path = _expand(os.environ.get("RETRO_MAC_CONFIG") or ROOT / "config.toml")
    if path.exists() and tomllib:
        with open(path, "rb") as f:
            cfg = _merge(cfg, tomllib.load(f))
    cfg = _merge(cfg, {})  # copy
    env = os.environ
    if env.get("RETRO_MAC_PORT"):
        cfg["server"]["port"] = int(env["RETRO_MAC_PORT"])
    if env.get("RETRO_MAC_DEMO", "").lower() in ("1", "true", "yes") or "--demo" in sys.argv:
        cfg["server"]["demo"] = True
    if env.get("HERMES_HOME"):
        cfg["hermes"]["home"] = env["HERMES_HOME"]
    if env.get("RETRO_MAC_HERMES_PYTHON"):
        cfg["limits"]["python"] = env["RETRO_MAC_HERMES_PYTHON"]
    if env.get("RETRO_MAC_SCREEN_NAME"):
        cfg["aol"]["screen_name"] = env["RETRO_MAC_SCREEN_NAME"]
    if not cfg["location"].get("timezone"):
        cfg["location"]["timezone"] = _local_tz_name()
    return cfg


CFG = load()
DEMO = bool(CFG["server"]["demo"])
PORT = int(CFG["server"]["port"])
TZ_NAME = CFG["location"]["timezone"]
HERMES_HOME = _expand(CFG["hermes"]["home"])
VOICE_SESSION = CFG["hermes"]["voice_session"]
HERMES_PYTHON = _expand(CFG["limits"]["python"]) if CFG["limits"].get("python") else None
LIMITS_PROVIDER = str(CFG["limits"].get("provider") or "anthropic")
SCREEN_NAME = clean_screen_name((CFG.get("aol") or {}).get("screen_name"))
# Runtime state (settings.json, attention.json, logs). Never committed.
DATA_DIR = _expand(os.environ.get("RETRO_MAC_DATA") or ROOT / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR = DATA_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
_vd = _expand(os.environ.get("RETRO_MAC_VOICES") or CFG["voices"]["dir"])
VOICES_DIR = _vd if _vd.is_absolute() else ROOT / _vd
