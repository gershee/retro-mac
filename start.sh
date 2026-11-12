#!/bin/bash
# Start the Retro Mac display server (127.0.0.1 only).
#   ./start.sh            real mode (config.toml; Hermes + feeds)
#   ./start.sh --demo     demo mode: sample weather/agenda/crew, no Hermes, no network, no calendar
#   RETRO_MAC_PORT=8797 ./start.sh --demo    any port
#   ./start.sh --fg [--demo]                 stay in the foreground (logs to the terminal)
set -e
cd "$(dirname "$0")"
PORT=${RETRO_MAC_PORT:-8787}
DATA=${RETRO_MAC_DATA:-data}
PY=${PYTHON:-}
if [ -z "$PY" ]; then
  if [ -x venv/bin/python ]; then PY=venv/bin/python; elif [ -x .venv/bin/python ]; then PY=.venv/bin/python; else PY=python3; fi
fi
ARGS=(); FG=0
for a in "$@"; do case "$a" in --fg) FG=1 ;; *) ARGS+=("$a") ;; esac; done
if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "already running on :$PORT"; exit 0; fi
mkdir -p "$DATA/logs"
export RETRO_MAC_PORT=$PORT
if [ "$FG" = 1 ]; then exec "$PY" server/server.py "${ARGS[@]}"; fi
# The server writes its own rotating log (data/logs/server.log, 2 MB x 3); server.out only catches startup crashes.
nohup "$PY" server/server.py "${ARGS[@]}" > "$DATA/logs/server.out" 2>&1 &
echo "starting (pid $!), log: $DATA/logs/server.log"
for i in $(seq 1 60); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "up:   http://127.0.0.1:$PORT/        (kiosk)"
    echo "      http://127.0.0.1:$PORT/?test   (test buttons: make a face talk; click once to unlock sound)"
    exit 0
  fi
  sleep 1
done
echo "server did not answer within 60 s; see $DATA/logs/server.log and server.out" >&2; exit 1
