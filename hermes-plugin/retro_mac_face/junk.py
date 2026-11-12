"""Junk-transcript filter shared by the hook (gateway process) and server.py (loaded by file path).

Whisper returns tags / hallucinations for silence and room noise ("[BLANK_AUDIO]", "(inaudible)", "[SOUND]",
"you", "Thanks for watching"). Those must never become a spoken turn. Pure functions, no imports beyond re.
"""
import re

# Whisper-style annotation groups. Short (<= 30 chars) so a real bracketed system message such as
# "[IMPORTANT: Background process ...]" is never treated as noise.
# Groups up to 80 chars ("(speaking in a foreign language)", "(upbeat music playing)"), a music-note line, or an unclosed
# trailing "(foreign". A transcript that is ONLY such groups is junk; real words around them keep it real.
_TAG_RE = re.compile(r"\[[^\]]{0,80}\]|\([^)]{0,80}\)|\*[^*]{0,80}\*|[\u266a\u266b\u2669][^\u266a\u266b\u2669]*[\u266a\u266b\u2669]?|"
                     r"[\[(*][^\])*]{0,80}$")
_NONWORD_RE = re.compile(r"[^a-z0-9' ]+")

# one or more of these words, nothing else = noise (case-insensitive)
FILLER_WORDS = frozenset({"you", "uh", "um", "umm", "uhh", "hmm", "hm", "mm", "mmm", "mhm", "ah", "oh", "huh",
                          "bye"})
# whole-utterance hallucinations
FILLER_PHRASES = frozenset({"thanks for watching", "thank you for watching", "thanks for watching!", "bye bye",
                            "the end", "see you next time", "see you in the next video", "please subscribe",
                            "subtitles by the amara.org community"})
_FILLER_PREFIXES = ("subtitles by", "transcribed by", "captions by", "amara.org")


def is_junk(text) -> bool:
    """True when `text` carries no real speech: empty, only tags/brackets/punctuation, or a lone filler."""
    if not isinstance(text, str):
        return True
    s = text.strip()
    if not s:
        return True
    if len(s) > 120:                      # long = real speech, skip the regex work
        return False
    low = s.lower()
    rest = _TAG_RE.sub(" ", low)          # [BLANK_AUDIO] (inaudible) [ ] [Music] *sigh* ...
    rest = _NONWORD_RE.sub(" ", rest)     # '...', stray brackets, punctuation
    words = rest.split()
    if not words:                         # nothing left but tags / punctuation
        return True
    flat = " ".join(words)
    if flat in FILLER_PHRASES or flat.startswith(_FILLER_PREFIXES):
        return True
    if len(flat) == 1:                    # a lone letter
        return True
    return all(w in FILLER_WORDS for w in words)
