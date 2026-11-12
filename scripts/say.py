#!/usr/bin/env python3
"""Make the Retro Mac faces talk (stdlib only). Uses "force": true so it speaks even though nobody said the wake word.

  python3 scripts/say.py                     tour: alfred, scout, maker, then a list card
  python3 scripts/say.py maker               one canned line
  python3 scripts/say.py scout "Hello there"  any text, any agent ([happy] / [thinking] ... tags set the mood)
  RETRO_MAC_PORT=8797 python3 scripts/say.py  another port
"""
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("RETRO_MAC_BASE", "http://127.0.0.1:%s" % os.environ.get("RETRO_MAC_PORT", "8787")) + "/speak"

TESTS = {
    "alfred": {"agent": "alfred", "text": "Good morning. Everything is running smoothly, and I have nothing urgent for you."},
    "scout": {"agent": "scout", "text": "[curious] Scout here. I found three new leads overnight, and one of them looks promising."},
    "maker": {"agent": "maker", "text": "[happy] Maker reporting. The build finished, all tests passed, and the update is ready to ship."},
    "card": {
        "agent": "alfred",
        "text": "Here's your day:\n- 9:30 Team standup\n- 11:00 Design review\n- 3:15 School pickup\n- 6:30 Climbing gym",
    },
    "number": {
        "agent": "scout",
        "text": "It is fifty six degrees outside, with rain after four.",
        "card": {"type": "number", "title": "WEATHER", "value": "56", "unit": "DEGREES F", "sub": "Rain 4P-7P. Bring an umbrella."},
    },
}


def send(body):
    req = urllib.request.Request(URL, json.dumps(dict(body, force=True)).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] in ("alfred", "scout", "maker"):
        print(args[0], send({"agent": args[0], "text": args[1]}))
        sys.exit(0)
    for name in args or ["alfred", "scout", "maker", "card"]:
        print(name, send(TESTS[name]))
        time.sleep(7)  # let each clip finish before the next one
