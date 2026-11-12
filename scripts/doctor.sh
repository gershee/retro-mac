#!/bin/bash
# Retro Mac health check. Read-only; every check is time-limited.
R="$(cd "$(dirname "$0")/.." && pwd)"
D=${RETRO_MAC_DATA:-$R/data}
PORT=${RETRO_MAC_PORT:-8787}
B=http://127.0.0.1:$PORT
WL=$D/logs/wake.log
SL=$D/logs/server.log
FAILS=0; WARNS=0
ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS+1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS+1)); }

PS=$(ps -axww -o command= 2>/dev/null)

# server
H=$(curl -s -m 2 $B/health 2>/dev/null)
if [ -z "$H" ]; then
  fail "server: no response from $B/health"
else
  R2=$(printf '%s' "$H" | /usr/bin/env python3 -c '
import sys,json
try:
    d=json.load(sys.stdin)
    print(("1" if d.get("ok") else "0"), d.get("clients",0), len(d.get("voices",[])))
except Exception: print("bad")' 2>/dev/null)
  set -- $R2
  if [ "$R2" = "bad" ] || [ -z "$R2" ]; then fail "server: unparseable /health response"
  elif [ "$1" != 1 ]; then fail "server: /health ok=false"
  else
    ok "server: up, $3 voices"
    if [ "$2" -ge 1 ]; then ok "screen: $2 connected"; else fail "screen: 0 clients connected (kiosk browser not attached)"; fi
  fi
fi

# voice banner / voice state (v0.4)
if [ -n "$H" ]; then
  VOUT=$(printf '%s' "$H" | /usr/bin/env python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = d.get("voice")
if not isinstance(v, dict):
    print("FAIL|voice state: /health has no voice field (server.py predates the voice banner)"); sys.exit(0)
st, age = v.get("state"), float(v.get("age") or 0)
t = v.get("turn") or {}
desc = st + (" for %ds" % age)
if t:
    desc += ", turn %ds on %r, step %s, heartbeat %ss ago" % (t.get("elapsed", 0), (t.get("text") or "")[:40], t.get("label"), t.get("beat_age"))
if st == "working" and t and t.get("elapsed", 0) > 1800:
    print("WARN|voice state: " + desc + " (turn over 30 min)")
elif st not in ("idle", "working", "speaking") and age > 600:
    print("WARN|voice state: stuck? " + desc)
else:
    print("OK|voice state: " + desc)
p = v.get("pending") or []
print("OK|voice jobs pending: %d%s" % (len(p), (" (" + ", ".join(j.get("label", "?") for j in p) + ")") if p else ""))
tui = d.get("tui") or {}
if not tui.get("seen"):
    print("WARN|voice session pane: no Hermes status line seen in tmux hermes-voice")
elif tui.get("voice_on") is False:
    print("WARN|voice session: TUI voice is OFF (server re-enables it within ~1 min; else send /voice on)")
else:
    print("OK|voice session: voice on, %s" % ("idle" if tui.get("ready") else "BUSY (a turn is running)"))
cb, b = d.get("client_builds") or [], d.get("build")
old = [x for x in cb if x != b]
if cb and not old:
    print("OK|screen JS: current build %s on %d display(s)" % (b, len(cb)))
elif cb:
    print("WARN|screen JS: %d display(s) on an old build %s (reload the kiosk once; later edits reload by themselves)" % (len(old), old))
ha = d.get("hook_v4_age")
if ha is None:
    print("WARN|hook: no v0.4 activity seen since the server started (gateway plugin not reloaded yet, or nobody has worked)")
else:
    print("OK|hook: v0.4 plugin live (last activity %ds ago)" % ha)
' 2>/dev/null)
  while IFS='|' read -r lvl msg; do
    case "$lvl" in OK) ok "$msg";; WARN) warn "$msg";; FAIL) fail "$msg";; esac
  done <<< "$VOUT"
  for path in /voice_state /banner.js; do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$B$path")
    if [ "$code" = 200 ]; then ok "endpoint: GET $path 200"; else fail "endpoint: GET $path -> $code"; fi
  done
  if curl -s -m 2 $B/ | grep -q 'banner.js'; then ok "page: index.html loads banner.js"; else fail "page: index.html does not load banner.js"; fi

  # kiosk2: sentence-streamed speech, step checklist, hook v0.5 (all read-only)
  SOUT=$(printf '%s' "$H" | /usr/bin/env python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
s = d.get("speech")
if not isinstance(s, dict):
    print("FAIL|speech: /health has no speech field (server.py predates streaming TTS)"); sys.exit(0)
sc, lc = s.get("stream_clients", 0), s.get("legacy_clients", 0)
if lc:
    print("WARN|speech: %d display(s) without caps:stream get one whole WAV (old face.js; reload the kiosk)" % lc)
elif sc:
    print("OK|speech: %d streaming display(s), synth %s, %d queued" % (sc, "busy" if s.get("busy") else "idle", s.get("queued", 0)))
else:
    print("WARN|speech: no streaming display connected")
last = s.get("last") or {}
if last:
    print("OK|speech: last %s #%s (%s)" % (last.get("kind"), last.get("id"), ", ".join("%s=%s" % (k, v) for k, v in last.items() if k in ("sentences", "ttfa", "total"))))
' 2>/dev/null)
  while IFS='|' read -r lvl msg; do
    case "$lvl" in OK) ok "$msg";; WARN) warn "$msg";; FAIL) fail "$msg";; esac
  done <<< "$SOUT"
  if curl -s -m 2 $B/face.js | grep -q "caps: \['stream'\]"; then ok "page: face.js announces caps:stream"; else warn "page: served face.js has no streaming player (legacy whole-WAV path)"; fi
  if curl -s -m 2 $B/banner.js | grep -q 'tr.steps'; then ok "page: banner.js has the step checklist"; else warn "page: served banner.js has no step checklist"; fi
  # failed-turn banner (LIMIT HIT / SOMETHING WENT WRONG) + stuck-turn watchdog; /health.fail exists only on a server that has the pane watcher
  if curl -s -m 2 $B/banner.js | grep -q "LIMIT HIT"; then ok "page: banner.js has the failed-turn banner"; else warn "page: served banner.js has no failed-turn banner"; fi
  if curl -s -m 2 $B/health | grep -q '"fail"'; then ok "voice: failure watcher live (/health.fail; hermes-voice pane -> LIMIT HIT / SOMETHING WENT WRONG, watchdog at 180 s)"; else warn "voice: server has no failure watcher (restart the display server)"; fi
fi

# hook v0.5 on disk, and whether the voice session process has loaded it (started after the file changed)
HOOKF=$R/hermes-plugin/retro_mac_face/__init__.py
if grep -q 'register_hook("on_interim_message"' "$HOOKF" 2>/dev/null; then
  ok "hook: v0.5 on disk (on_interim_message narration, step captions)"
  VPID=$(tmux list-panes -t hermes-voice -F '#{pane_pid}' 2>/dev/null | head -1)
  if [ -n "$VPID" ]; then
    VSTART=$(date -j -f '%a %b %d %T %Y' "$(ps -o lstart= -p "$VPID" 2>/dev/null)" +%s 2>/dev/null)
    HMT=$(stat -f %m "$HOOKF" "$(dirname "$HOOKF")/junk.py" 2>/dev/null | sort -n | tail -1)
    if [ -n "$VSTART" ] && [ "$VSTART" -lt "$HMT" ]; then
      warn "hook: voice session (pid $VPID) started before the hook changed; restart com.hermes.retro-mac-voice-session (display server first)"
    elif [ -n "$VSTART" ]; then ok "hook: voice session started after the last hook change"; fi
  fi
else
  warn "hook: retro_mac_face has no on_interim_message (pre-v0.5: no spoken narration between tool steps)"
fi

# junk transcripts + false wakes (v0.6 hook / server / wake gate)
if grep -q '_junk_block' "$HOOKF" 2>/dev/null; then ok "junk: hook blocks junk voice transcripts before the model (junk.py)"; else warn "junk: hook has no junk block (voice turns on [BLANK_AUDIO] reach the model and get spoken)"; fi
if curl -s -m 2 $B/health | grep -q '"junk"'; then ok "junk: server drops junk transcripts (/health.junk, /voice_junk)"; else warn "junk: running server predates the junk filter (restart the display server)"; fi
# v1.1 click-in windows: /house is read-only (cached 60 s); list any services it reports down
HS=$(curl -s -m 15 $B/house 2>/dev/null)
if echo "$HS" | grep -q '"services"'; then
  HD=$(echo "$HS" | grep -oE '"name": "[^"]+", "up": false, "note": "[^"]+"' | sed -E 's/"name": "([^"]+)", "up": false, "note": "([^"]+)"/\1 (\2)/' | paste -sd ',' -)
  if [ -z "$HD" ]; then ok "house: /house live, all services up (click-in window 4)"; else warn "house: /house reports down: $HD"; fi
else warn "house: no /house endpoint (server predates v1.1 windows; restart the display server)"; fi
if [ -f "$WL" ]; then
  WPID=$(pgrep -f 'voice/wake_daemon.py' | head -1)
  WSTART=$(date -j -f '%a %b %d %T %Y' "$(ps -o lstart= -p "$WPID" 2>/dev/null)" +%s 2>/dev/null)
  WMT=$(stat -f %m $R/voice/wake_daemon.py $R/voice/wake_gate.py 2>/dev/null | sort -n | tail -1)
  if [ -n "$WSTART" ] && [ -n "$WMT" ] && [ "$WSTART" -lt "$WMT" ]; then warn "wake: daemon (pid $WPID) started before wake_daemon.py/wake_gate.py changed (false-wake gate not live; SIGTERM it, launchd restarts)"
  elif [ -n "$WSTART" ]; then ok "wake: daemon runs the false-wake gate"; fi
  TODAY=$(date +%Y-%m-%d)
  NF=$(grep -c "^$TODAY .*heard <" "$WL"); NR=$(grep -c "^$TODAY .*REJECTED" "$WL")
  ok "wake today: $NF fires seen, $NR rejected by the gate, $((NF-NR)) woke the mic (>5 a day = still noisy; check 'level 1s before' in wake.log)"
fi

# push-to-talk mode (temporary): wake word off, Space is the talk key. `scripts/ptt on|off|status`
if [ -n "$H" ]; then
  if ! printf '%s' "$H" | grep -q '"ptt"'; then warn "ptt: running server predates push-to-talk mode (restart the display server)"
  elif printf '%s' "$H" | grep -q '"ptt": true'; then
    ok "ptt: push-to-talk mode ON (wake word ignored; tap SPACE on the kiosk to talk; revert: scripts/ptt off)"
    if grep 'push-to-talk mode' "$WL" 2>/dev/null | tail -n 1 | grep -q 'mode ON'; then ok "ptt: wake daemon follows push-to-talk (spotter paused)"; else warn "ptt: wake daemon has not logged push-to-talk mode (restart it: SIGTERM, launchd restarts)"; fi
  else ok "ptt: push-to-talk mode off (wake word \"alfred\" live; enable: scripts/ptt on)"; fi
fi

# kiosk process
if printf '%s\n' "$PS" | grep -q -- "--user-data-dir=$D/chrome-profile"; then ok "kiosk: Chrome running"; else fail "kiosk: Chrome not running with retro-mac profile"; fi

# wake listener
if printf '%s\n' "$PS" | grep -q 'wake_daemon\.py'; then ok "wake listener: running"; else fail "wake listener: not running"; fi

# tmux
if timeout 3 tmux has-session -t =hermes-voice 2>/dev/null; then ok "voice session: tmux hermes-voice present"; else fail "voice session: tmux hermes-voice missing"; fi

# plugin config
for f in ~/.hermes/config.yaml ~/.hermes/profiles/{scout,maker}/config.yaml; do
  n=${f#$HOME/.hermes/}
  if [ ! -f "$f" ]; then warn "plugin: $n missing"; continue; fi
  if /usr/bin/env python3 - "$f" <<'PY' 2>/dev/null
import sys,re
lines=open(sys.argv[1]).read().splitlines()
inp=False; inen=False
for l in lines:
    if re.match(r'^plugins:\s*$',l): inp=True; inen=False; continue
    if inp:
        if re.match(r'^\S',l): break
        if re.match(r'^  enabled:',l): inen=True; continue
        if re.match(r'^  \S',l): inen=False
        if inen and re.match(r'^\s*-\s*retro_mac_face\s*$',l): sys.exit(0)
sys.exit(1)
PY
  then ok "plugin: retro_mac_face enabled in $n"; else fail "plugin: retro_mac_face not enabled in $n"; fi
done

# wake.log freshness
PTT_ON=0; printf '%s' "$H" | grep -q '"ptt": true' && PTT_ON=1
if [ -f "$WL" ]; then
  LINE=$(grep 'mic peak last 20s' "$WL" | tail -n 1)
  MICST=$(grep -E 'mic (opened|released)' "$WL" | tail -n 1)
  if [ "$PTT_ON" = 1 ]; then
    # push-to-talk: the daemon must NOT hold the mic when idle (no stream, no spotter, no level lines). Read-only OS check:
    # a process with a live CoreAudio input runs a 'com.apple.audio.IOThread.client' thread (lsof cannot see CoreAudio).
    WPID=$(pgrep -f 'voice/wake_daemon.py' | head -1)
    HELD=unknown
    if [ -n "$WPID" ]; then
      if timeout 15 sample "$WPID" 1 -mayDie 2>/dev/null | grep -q 'com.apple.audio.IOThread.client'; then HELD=yes; else HELD=no; fi
    fi
    VSTATE=$(printf '%s' "$H" | /usr/bin/env python3 -c 'import sys,json
try: print((json.load(sys.stdin).get("voice") or {}).get("state",""))
except Exception: print("")' 2>/dev/null)
    case "$MICST" in
      *'mic released (ptt idle)'*)
        if [ "$HELD" = no ]; then ok "mic: ptt on, wake daemon NOT holding the mic (released, idle)"
        elif [ "$HELD" = yes ]; then fail "mic: ptt on and logged 'mic released' but daemon pid $WPID still holds a CoreAudio input"
        else warn "mic: ptt on, log says released; OS check unavailable (no daemon pid / sample failed)"; fi ;;
      *'mic opened'*)
        if [ "$VSTATE" = listening ] || [ "$VSTATE" = heard ]; then ok "mic: ptt window open right now (state $VSTATE), closes when the turn's mic window ends"
        else warn "mic: ptt on but the mic is still open and the server is '$VSTATE' (window should have closed)"; fi ;;
      *) warn "mic: ptt on but wake.log has no 'mic released (ptt idle)' line (daemon predates the idle-release change: SIGTERM it, launchd restarts)" ;;
    esac
  elif [ -z "$LINE" ]; then fail "mic: no 'mic peak' lines in wake.log"
  else
    TS=${LINE:0:19}
    EP=$(date -j -f '%Y-%m-%d %H:%M:%S' "$TS" +%s 2>/dev/null)
    N=${LINE##*: }
    if [ -z "$EP" ]; then fail "mic: cannot parse timestamp '$TS'"
    else
      AGE=$(( $(date +%s) - EP ))
      if [ "$AGE" -ge 60 ]; then fail "mic: last peak line ${AGE}s old (listener stalled)"
      elif ! [[ "$N" =~ ^[0-9]+$ ]]; then fail "mic: unparseable level"
      elif [ "$N" -eq 0 ]; then
        # dead mic if the last 6 readings (~2 min) are all 0
        if [ "$(grep 'mic peak last 20s' "$WL" | tail -n 6 | grep -vc ': 0$')" -eq 0 ]; then fail "mic: peak 0 for 2+ min (dead mic?)"; else warn "mic: peak 0 right now (${AGE}s ago)"; fi
      else ok "mic: peak $N (${AGE}s ago)"; fi
    fi
  fi
  SP=$(grep 'start phrases=' "$WL" | tail -n 1)
  if [ -n "$SP" ]; then ok "wake.log: last start ${SP:0:19}"; else fail "wake.log: no 'start phrases=' line"; fi
else
  fail "wake.log: missing"
fi

# server.log tracebacks
if [ -f "$SL" ]; then
  if tail -n 200 "$SL" | grep -q 'Traceback'; then fail "server.log: Traceback in last 200 lines"; else ok "server.log: no Traceback in last 200 lines"; fi
else
  warn "server.log: missing"
fi

# launchd
LL=$(timeout 3 launchctl list 2>/dev/null)
for a in server:retro-mac-server voice-session:retro-mac-voice-session wake:retro-mac-wake kiosk:retro-mac-kiosk; do
  name=${a%%:*}; label=com.hermes.${a#*:}
  if printf '%s\n' "$LL" | awk -v l="$label" '$3==l{f=1} END{exit !f}'; then ok "launchd: $name agent loaded"
  else warn "launchd: $name agent not loaded (run scripts/install-autostart.sh in Terminal.app)"; fi
done

echo
if [ $FAILS -gt 0 ]; then echo "SUMMARY: $FAILS FAIL, $WARNS WARN"; exit 1; fi
echo "SUMMARY: all clear, $WARNS WARN"; exit 0
