"""Crew journal: what the crew did today, persisted one JSON line per entry (stdlib only, no Hermes imports).

Used by server.py for the LOG window / inbox (GET /log) and the About box tallies. Entries survive a server
restart (the CREW window's in-memory `hist` does not). One file per local day: logs/crew-log-YYYY-MM-DD.jsonl.

    log = CrewLog(Path("logs"))
    log.add("done", "maker", "CODING face.js", took=42)
    log.add("reply", "alfred", "Good morning.")
    log.today()  -> {"day": "2026-11-14", "entries": [...oldest first...], "counts": {...}, "seq": 17}

Kinds: done (an agent finished a job: label + took seconds), reply (first spoken sentence), failed (voice turn died:
LIMIT HIT / error note), asked (a voice question from the user, clipped). Consecutive duplicates within DEDUPE_S
collapse into one entry (the hook can send the same label from several steps). A day holds at most MAX_PER_DAY
entries; older files are left alone (tiny) except `prune()` which deletes files older than KEEP_DAYS.
"""
import json
import os
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path

KINDS = ("done", "reply", "failed", "asked")
AGENTS = ("alfred", "scout", "maker")
MAX_PER_DAY = 500
DEDUPE_S = 60.0
KEEP_DAYS = 30
TEXT_MAX = 90
_CLEAN = re.compile(r"[^\w .,:;/+\-'\"@#&?!()%$\u00b0]")


def clean(s, n=TEXT_MAX) -> str:
    s = _CLEAN.sub("", str(s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    return s[: n - 2].rstrip() + ".." if len(s) > n else s


class CrewLog:
    def __init__(self, dirpath, now=None):
        self.dir = Path(dirpath)
        self.now = now or time.time          # injectable clock for tests
        self.day = None
        self.entries = []
        self.seq = 0
        self._load(self._day_of(self.now()))

    # ---------------------------------------------------------------- files
    @staticmethod
    def _day_of(ts) -> str:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

    def path_for(self, day: str) -> Path:
        return self.dir / f"crew-log-{day}.jsonl"

    def _load(self, day: str):
        self.day, self.entries = day, []
        try:
            for line in self.path_for(day).read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("kind") in KINDS:
                    self.entries.append(e)
        except OSError:
            pass
        self.entries = self.entries[-MAX_PER_DAY:]
        self.seq = len(self.entries)

    def _roll(self):
        day = self._day_of(self.now())
        if day != self.day:
            self._load(day)

    def _append_file(self, e: dict):
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            with open(self.path_for(self.day), "a", encoding="utf-8") as f:
                f.write(json.dumps(e, separators=(",", ":")) + "\n")
        except OSError:
            pass                              # the journal is a nicety: never take the display down for it

    # ---------------------------------------------------------------- api
    def add(self, kind: str, agent: str, text: str = "", **extra):
        """Record one thing. Returns the entry, or None if it was dropped (bad kind, empty text, duplicate)."""
        if kind not in KINDS:
            return None
        agent = agent if agent in AGENTS else "alfred"
        text = clean(text)
        if not text:
            return None
        self._roll()
        ts = round(float(self.now()), 1)
        if self.entries:
            last = self.entries[-1]
            if last["kind"] == kind and last["agent"] == agent and last["text"] == text and ts - last["at"] < DEDUPE_S:
                last["n"] = last.get("n", 1) + 1          # memory only: the file keeps the first occurrence
                return None
        e = {"at": ts, "kind": kind, "agent": agent, "text": text}
        for k in ("took", "note"):
            if k in extra and extra[k] not in (None, "", 0):
                e[k] = extra[k] if k == "note" else int(extra[k])
        self.entries.append(e)
        if len(self.entries) > MAX_PER_DAY:
            del self.entries[: len(self.entries) - MAX_PER_DAY]
        self.seq += 1
        self._append_file(e)
        return e

    def counts(self) -> dict:
        out = {a: {"done": 0, "reply": 0, "failed": 0, "asked": 0} for a in AGENTS}
        for e in self.entries:
            out[e["agent"]][e["kind"]] += 1
        return out

    def today(self, since: float = 0.0) -> dict:
        self._roll()
        ents = [e for e in self.entries if e["at"] > since] if since else list(self.entries)
        return {"day": self.day, "entries": ents, "counts": self.counts(), "seq": self.seq, "total": len(self.entries)}

    def unread(self, seen_at: float) -> int:
        self._roll()
        return sum(1 for e in self.entries if e["at"] > seen_at)

    def prune(self, keep_days: int = KEEP_DAYS) -> int:
        """Delete journal files older than keep_days. Returns how many were removed."""
        cutoff = (date.fromtimestamp(self.now()) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
        n = 0
        try:
            for p in self.dir.glob("crew-log-????-??-??.jsonl"):
                day = p.name[len("crew-log-"):-len(".jsonl")]
                if day < cutoff:
                    try:
                        os.remove(p)
                        n += 1
                    except OSError:
                        pass
        except OSError:
            pass
        return n
