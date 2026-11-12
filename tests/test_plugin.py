#!/usr/bin/env python3
"""retro_mac_face plugin state, offline: heartbeats for busy turns, idle/dead sessions pruned after STALE_AFTER.
Never posts anywhere (_post is replaced).

  venv/bin/python tests/test_plugin.py
"""
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ["RETRO_MAC_BASE"] = "http://127.0.0.1:9"          # never reached: _post is stubbed below
spec = importlib.util.spec_from_file_location("retro_mac_face_t", ROOT / "hermes-plugin/retro_mac_face/__init__.py",
                                              submodule_search_locations=[str(ROOT / "hermes-plugin/retro_mac_face")])
hook = importlib.util.module_from_spec(spec)
sys.modules["retro_mac_face_t"] = hook
spec.loader.exec_module(hook)

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     got  {got!r}\n     want {want!r}"))


posted = []
hook._post = lambda path, body, timeout=2.0: posted.append((path, body))
NOW = 1_000_000.0
S = hook.STALE_AFTER
hook._cur.clear()
hook._cur.update({
    ("alfred", "busy"): {"status": "working", "label": "CODING", "at": NOW - 30, "hb": NOW - 20},
    ("alfred", "idle-recent"): {"status": "idle", "label": "", "at": NOW - 60, "hb": 0.0},
    ("scout", "idle-old"): {"status": "idle", "label": "", "at": NOW - S - 1, "hb": 0.0},
    ("maker", "dead-turn"): {"status": "thinking", "label": "", "at": NOW - S - 5, "hb": NOW - S - 1},
    ("maker", "long-turn"): {"status": "thinking", "label": "", "at": NOW - S + 60, "hb": NOW - 10},
})
hook._tick(NOW)
check("idle + dead entries older than STALE_AFTER pruned", sorted(k[1] for k in hook._cur),
      ["busy", "idle-recent", "long-turn"])
check("heartbeat only for the busy turn that is due", [(p, b["session_id"]) for p, b in posted],
      [("/activity", "busy")])
check("heartbeat time recorded", hook._cur[("alfred", "busy")]["hb"], NOW)
for i in range(500):                                # a gateway that has seen many chats
    hook._cur[("alfred", f"s{i}")] = {"status": "idle", "label": "", "at": NOW - 100, "hb": 0.0}
hook._tick(NOW + S + 1)
check("hundreds of old sessions do not accumulate", len(hook._cur), 0)
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
