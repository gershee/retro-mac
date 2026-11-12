#!/usr/bin/env python3
"""Draw web/favicon.ico: a 1-bit happy Mac, by hand, pixel by pixel (16x16, plus a 2x nearest-neighbour 32x32).
Standard library only (PNG-in-ICO).   python3 scripts/make-favicon.py
"""
import struct
import zlib
from pathlib import Path

#  X = ink   . = paper (the Mac's body and screen)   space = transparent
HAPPY_MAC = [
    "  XXXXXXXXXXXX  ",
    "  X..........X  ",
    "  X.XXXXXXXX.X  ",
    "  X.X......X.X  ",
    "  X.X.X..X.X.X  ",
    "  X.X......X.X  ",
    "  X.X.X..X.X.X  ",
    "  X.X..XX..X.X  ",
    "  X.X......X.X  ",
    "  X.XXXXXXXX.X  ",
    "  X..........X  ",
    "  X.XX..XXXX.X  ",
    "  X..........X  ",
    "  XXXXXXXXXXXX  ",
    "  X..........X  ",
    "  XXXXXXXXXXXX  ",
]
INK, PAPER, CLEAR = (20, 20, 18, 255), (233, 232, 220, 255), (0, 0, 0, 0)   # web/index.html --ink / --paper


def png(rows, scale):
    n = len(rows) * scale
    raw = b""
    for r in rows:
        line = b"".join(bytes(INK if c == "X" else PAPER if c == "." else CLEAR) * scale for c in r)
        raw += (b"\x00" + line) * scale
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico(images):
    head = struct.pack("<HHH", 0, 1, len(images))
    off, dirs, data = 6 + 16 * len(images), b"", b""
    for size, blob in images:
        dirs += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(blob), off + len(data))
        data += blob
    return head + dirs + data


if __name__ == "__main__":
    assert all(len(r) == 16 for r in HAPPY_MAC) and len(HAPPY_MAC) == 16
    out = Path(__file__).resolve().parents[1] / "web" / "favicon.ico"
    out.write_bytes(ico([(16, png(HAPPY_MAC, 1)), (32, png(HAPPY_MAC, 2))]))
    print(f"wrote {out} ({out.stat().st_size} bytes)")
