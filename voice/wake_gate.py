"""Pure gating decision for a wake-word fire (no audio / network imports, unit-testable).

A keyword-spotter fire is only trusted if there was real sound under it, it did not come right after the face
finished talking, and the daemon is not in a cooldown after a no-speech close / junk transcript.
"""
from typing import Optional


def is_short(phrase: str) -> bool:
    """'ALF' / 'HEY_ALF' style: the bare short nickname is the most false-prone phrase."""
    last = str(phrase).replace("-", "_").split("_")[-1]
    return len(last) <= 3


def gate(*, now: float, phrase: str, pre_max: float, quiet_until: float, speech_ended: float,
         floor: float, short_floor: float, after_speech_gap: float) -> Optional[str]:
    """None = accept the fire, else a short reason string for the log."""
    if now < quiet_until:
        return f"cooldown {quiet_until - now:.0f}s left (after a no-speech close / junk transcript)"
    if after_speech_gap > 0 and speech_ended > 0 and now - speech_ended < after_speech_gap:
        return f"{now - speech_ended:.1f}s after the face stopped talking (< {after_speech_gap:.0f}s)"
    need = max(floor, short_floor) if is_short(phrase) else floor
    if pre_max < need:
        return f"too quiet: peak rms {pre_max:.0f} < {need:.0f} in the 1 s before the fire"
    return None
