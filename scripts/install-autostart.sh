#!/bin/bash
# macOS: install login auto-start (launchd) for the whole Retro Mac setup:
#   server         display server (KeepAlive)
#   voice-session  `hermes --tui` in tmux with voice mode on      (skip with --no-voice)
#   wake           wake word / push-to-talk mic daemon            (skip with --no-voice)
#   kiosk          full-screen Chrome kiosk (KeepAlive on crash; Cmd+Q stays quit,
#                  bring it back with: launchctl kickstart gui/$(id -u)/com.hermes.retro-mac-kiosk)
# Run from Terminal.app (not from inside a Hermes session). Safe to re-run. The first time the wake daemon runs
# under launchd, macOS asks to let python use the microphone: click Allow.
#   WAKE_PYTHON=/path/to/python  python with sherpa-onnx + sounddevice (default: Hermes's venv python)
#   scripts/install-autostart.sh --uninstall
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"; U=$(id -u)
PORT=${RETRO_MAC_PORT:-8787}
LABELS="server voice-session wake kiosk"
for a in "$@"; do
  case "$a" in
    --no-voice) LABELS="server kiosk" ;;
    --uninstall)
      for n in server voice-session wake kiosk; do
        launchctl bootout "gui/$U/com.hermes.retro-mac-$n" 2>/dev/null || true; rm -f "$LA/com.hermes.retro-mac-$n.plist"
      done; echo "uninstalled"; exit 0 ;;
  esac
done
WAKE_PYTHON=${WAKE_PYTHON:-$(ls -d "$HOME"/.hermes/hermes-agent/venv/bin/python3 "$HOME"/.hermes/tools/python-3*/bin/python3 2>/dev/null | head -1)}
[ -x "$REPO/venv/bin/python" ] || { echo "create the venv first: python3 -m venv venv && venv/bin/pip install -r requirements.txt" >&2; exit 1; }
case " $LABELS " in *" wake "*) [ -x "$WAKE_PYTHON" ] || { echo "no python for the wake daemon (set WAKE_PYTHON or use --no-voice)" >&2; exit 1; } ;; esac
chmod +x "$REPO"/voice/voice-session.sh "$REPO"/scripts/*.sh "$REPO"/start.sh
mkdir -p "$LA" "$REPO/data/logs"
for n in $LABELS; do
  sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" -e "s#__PORT__#$PORT#g" -e "s#__WAKE_PYTHON__#$WAKE_PYTHON#g" \
      "$REPO/examples/launchd/com.hermes.retro-mac-$n.plist.in" > "$LA/com.hermes.retro-mac-$n.plist"
  plutil -lint "$LA/com.hermes.retro-mac-$n.plist"
done
for n in $LABELS; do launchctl bootout "gui/$U/com.hermes.retro-mac-$n" 2>/dev/null || true; done
# hand over from a server started by hand on the same port
P=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); [ -n "$P" ] && kill $P 2>/dev/null || true
sleep 2
for n in $LABELS; do launchctl bootstrap "gui/$U" "$LA/com.hermes.retro-mac-$n.plist"; done
echo "installed: $LABELS. Give it ~45 seconds, then tap Space (push-to-talk) or say the wake word."
