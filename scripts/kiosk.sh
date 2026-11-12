#!/bin/bash
# Open the Retro Mac face as a true full-screen kiosk (no tab bar, no address bar, sound allowed). macOS + Chrome.
# Exit with Cmd+Q. Uses its own Chrome profile (data/chrome-profile) so it never touches your normal browser.
cd "$(dirname "$0")/.."
PORT=${RETRO_MAC_PORT:-8787}
URL="${1:-http://127.0.0.1:$PORT/}"
DATA=${RETRO_MAC_DATA:-$PWD/data}
CHROME=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
./start.sh >/dev/null 2>&1   # make sure the server is up (no-op if already running)
# caffeinate -d -i: keep the display (and screensaver) from sleeping while the kiosk runs; ends when Chrome quits.
exec /usr/bin/caffeinate -d -i "$CHROME" \
  --user-data-dir="$DATA/chrome-profile" \
  --kiosk --app="$URL" \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run --no-default-browser-check --disable-features=Translate,InfiniteSessionRestore \
  --disable-session-crashed-bubble --noerrdialogs \
  --hide-scrollbars --overscroll-history-navigation=0 \
  ${RETRO_DEBUG_PORT:+--remote-debugging-port=$RETRO_DEBUG_PORT}
