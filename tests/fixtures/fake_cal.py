#!/usr/bin/env python3
"""Fake [calendar].command for tests/test_feeds.py:  fake_cal.py <calendar> <start> <end>"""
import json
import sys

cal, start = sys.argv[1], sys.argv[2]
day = start[:10]
if cal == "bad":
    print("error: token expired", file=sys.stderr)
    sys.exit(1)
if cal == "empty":
    print("[]")
    sys.exit(0)
print("fetched 2 events")           # text before the first '[' is ignored
print(json.dumps([
    {"summary": f"{cal} standup", "start": {"dateTime": f"{day}T11:00:00+00:00"}, "end": {"dateTime": f"{day}T11:30:00+00:00"}},
    {"summary": "Shared lunch", "start": f"{day}T16:00:00+00:00", "end": f"{day}T17:00:00+00:00"},
    {"summary": "Cancelled", "status": "cancelled", "start": f"{day}T18:00:00+00:00", "end": f"{day}T19:00:00+00:00"},
]))
