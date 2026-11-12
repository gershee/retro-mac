#!/bin/bash
# Keeps the Hermes voice TUI alive in a tmux session (default "hermes-voice"). The wake daemon / Space-bar
# push-to-talk presses its record key (Ctrl-B); the display server reads its pane to follow REC / ready state.
# Hermes's own wake listener is NOT enabled here: voice/wake_daemon.py owns the microphone instead.
#   HERMES_BIN               hermes executable (default: `hermes` on PATH)
#   RETRO_MAC_VOICE_SESSION  tmux session name (default hermes-voice)
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SESSION=${RETRO_MAC_VOICE_SESSION:-hermes-voice}
HERMES=${HERMES_BIN:-$(command -v hermes)}
TMUX=$(command -v tmux || echo /usr/local/bin/tmux)
LOG=${RETRO_MAC_DATA:-$HERE/data}/logs/voice-session.log
mkdir -p "$(dirname "$LOG")"; cd "${HERMES_HOME:-$HOME/.hermes}" || exit 1
[ -x "$HERMES" ] || { echo "hermes not found (set HERMES_BIN)" >&2; exit 1; }
while true; do
  if ! "$TMUX" has-session -t "=$SESSION" 2>/dev/null; then
    echo "$(date): launching $SESSION" >>"$LOG"
    "$TMUX" new-session -d -s "$SESSION" -x 200 -y 50 "$HERMES" --tui
    ( sleep 30; "$TMUX" send-keys -t "$SESSION" '/voice on' 2>/dev/null; sleep 2; "$TMUX" send-keys -t "$SESSION" Enter 2>/dev/null
      echo "$(date): voice on" >>"$LOG" ) &
  fi
  sleep 30
done
