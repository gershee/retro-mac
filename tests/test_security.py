#!/usr/bin/env python3
"""Host + Origin guard (DNS rebinding / cross-site requests). Silent; starts tests/testsrv.py on a spare port.

  venv/bin/python tests/test_security.py [port]
"""
import http.client
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("RETRO_MAC_PORT", "8792"))
FAILS = []


def req(method, path, host=None, origin=None, body=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    h = {"Host": host or f"127.0.0.1:{PORT}", "Content-Type": "application/json"}
    if origin is not None:
        h["Origin"] = origin
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    r.read()
    c.close()
    return r.status


def ws_status(origin):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    hdr = (f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n")
    if origin:
        hdr += f"Origin: {origin}\r\n"
    s.sendall((hdr + "\r\n").encode())
    line = s.recv(64).decode("latin-1").split("\r\n")[0]
    s.close()
    return int(line.split()[1])


def check(name, got, want):
    ok = got in want if isinstance(want, (tuple, range)) else got == want
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"   [got {got}, want {want}]"))
    if not ok:
        FAILS.append(name)


srv = subprocess.Popen([sys.executable, str(ROOT / "tests/testsrv.py"), str(ROOT / "server/server.py"), str(PORT)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(80):
        try:
            if req("GET", "/health") == 200:
                break
        except OSError:
            time.sleep(0.25)
    me = f"http://127.0.0.1:{PORT}"
    bad4xx = range(400, 500)
    # Host
    check("GET /health, Host 127.0.0.1:PORT", req("GET", "/health"), 200)
    check("GET /health, Host localhost:PORT", req("GET", "/health", host=f"localhost:{PORT}"), 200)
    check("GET /health, Host [::1]:PORT", req("GET", "/health", host=f"[::1]:{PORT}"), 200)
    check("GET /health, Host evil.example (DNS rebinding)", req("GET", "/health", host="evil.example"), bad4xx)
    check("GET /house, Host evil.example:PORT", req("GET", "/house", host=f"evil.example:{PORT}"), bad4xx)
    check("GET /, Host 127.0.0.1 on another port", req("GET", "/", host="127.0.0.1:1"), bad4xx)
    check("POST /refresh, Host evil.example", req("POST", "/refresh", host="evil.example", body="{}"), bad4xx)
    # Origin
    check("POST /refresh, no Origin (curl/plugin)", req("POST", "/refresh", body="{}"), 200)
    check("POST /refresh, own Origin", req("POST", "/refresh", origin=me, body="{}"), 200)
    check("POST /refresh, localhost Origin", req("POST", "/refresh", origin=f"http://localhost:{PORT}", body="{}"), 200)
    check("POST /refresh, foreign Origin", req("POST", "/refresh", origin="http://evil.example", body="{}"), 403)
    check("POST /refresh, Origin null", req("POST", "/refresh", origin="null", body="{}"), 403)
    check("POST /event, foreign Origin", req("POST", "/event", origin="https://evil.example", body='{"state":"idle"}'), 403)
    check("POST /stop, own Origin on wrong port", req("POST", "/stop", origin="http://127.0.0.1:1", body="{}"), 403)
    check("POST /voice_state, foreign Origin", req("POST", "/voice_state", origin="http://evil.example",
                                                   body='{"state":"idle"}'), 403)
    check("GET /voice_state, foreign Origin (read is fine)", req("GET", "/voice_state", origin="http://evil.example"), 200)
    check("GET /, foreign Origin (page load is fine)", req("GET", "/", origin="http://evil.example"), 200)
    # WebSocket
    check("/ws upgrade, no Origin", ws_status(None), 101)
    check("/ws upgrade, own Origin", ws_status(me), 101)
    check("/ws upgrade, foreign Origin", ws_status("http://evil.example"), 403)
finally:
    srv.terminate()
    srv.wait(5)
print("ALL PASS" if not FAILS else f"FAILURES: {len(FAILS)}")
sys.exit(1 if FAILS else 0)
