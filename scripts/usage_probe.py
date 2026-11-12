#!/usr/bin/env python3
"""Claude subscription usage for the kiosk LIMITS window (key 6). Prints ONE line of JSON, never a token:

  {"ok": true, "at": <epoch>, "windows": [{"label": "5-HOUR", "used": 78, "reset": <epoch>}, ...]}
  {"ok": false, "error": "..."}

Run it with the Hermes venv python (it imports Hermes' agent.account_usage; the kiosk server never does):

  ~/.hermes/hermes-agent/venv/bin/python scripts/usage_probe.py [--provider anthropic] [--hermes-dir DIR]

--hermes-dir defaults to the Hermes checkout that owns this interpreter (<dir>/venv/bin/python).
HERMES_HOME (env) picks the Hermes profile whose Claude login is read; unset = ~/.hermes.
"""
import argparse
import contextlib
import json
import re
import sys
import time
from pathlib import Path

LABELS = {"current session": "5-HOUR", "current week": "WEEK", "opus week": "OPUS WK", "sonnet week": "SONNET WK"}
_SECRETISH = re.compile(r"(sk-ant-[\w-]+|Bearer\s+\S+|[A-Za-z0-9_-]{32,})")


def short_label(label) -> str:
    s = str(label or "").strip()
    return LABELS.get(s.lower(), s.upper()[:10] or "?")


def clean_error(msg) -> str:
    return _SECRETISH.sub("[redacted]", " ".join(str(msg or "").split()))[:80] or "unknown error"


def to_payload(snapshot, now=None) -> dict:
    """Map a Hermes AccountUsageSnapshot (or None) to the kiosk JSON. Pure: unit-tested without Hermes."""
    now = time.time() if now is None else now
    if snapshot is None:
        return {"ok": False, "error": "no usage data (not signed in to Claude?)"}
    reason = getattr(snapshot, "unavailable_reason", None)
    if reason:
        return {"ok": False, "error": clean_error(reason)}
    rows = []
    for w in getattr(snapshot, "windows", None) or ():
        used = getattr(w, "used_percent", None)
        if used is None:
            continue
        reset = getattr(w, "reset_at", None)
        rows.append({"label": short_label(getattr(w, "label", "")),
                     "used": int(round(max(0.0, min(100.0, float(used))))),
                     "reset": int(reset.timestamp()) if reset is not None else None})
    if not rows:
        return {"ok": False, "error": "no usage windows reported"}
    return {"ok": True, "at": int(now), "windows": rows}


def _hermes_dir(arg) -> Path:
    if arg:
        return Path(arg).expanduser()
    return Path(sys.executable).parent.parent.parent        # <hermes-agent>/venv/bin/python -> <hermes-agent>


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--provider", default="anthropic")
    ap.add_argument("--hermes-dir", default="")
    a = ap.parse_args(argv)
    out = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):          # anything Hermes prints stays off the JSON line
            try:
                from agent.account_usage import fetch_account_usage
            except ImportError:
                sys.path.insert(0, str(_hermes_dir(a.hermes_dir)))
                from agent.account_usage import fetch_account_usage
            payload = to_payload(fetch_account_usage(a.provider))
    except ImportError:
        payload = {"ok": False, "error": "hermes not found (run with the Hermes venv python)"}
    except Exception as e:  # noqa: BLE001 - the kiosk just shows the short reason
        payload = {"ok": False, "error": clean_error(f"{type(e).__name__}: {e}")}
    out.write(json.dumps(payload) + "\n")
    out.flush()
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
