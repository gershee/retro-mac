# Contributing

Issues and PRs are welcome, especially new faces and moods, Raspberry Pi / systemd support, and calendar adapters.

1. Set up a dev environment: `python3 -m venv venv && venv/bin/pip install -r requirements.txt`, then `./start.sh --demo`.
2. Work on a spare port so you never disturb a running kiosk: `RETRO_MAC_PORT=8797 ./start.sh --demo --fg`.
3. Front-end changes: open `/?test` for the test buttons and preview params (`agent`, `mood`, `hour`, `idle`, `theme`, `tone`). The page reloads itself when the web files change.
4. Run the tests in `tests/` before you open a PR (see ARCHITECTURE.md). They are silent and use spare ports.
5. Keep the design rules: localhost only, the plugin fails open, and no personal data, model weights or voices in commits (`data/`, `config.toml`, `voices/` and `models/` are git-ignored).

Code style: plain Python 3.11 with the standard library plus aiohttp, and vanilla JS with no build step. Keep functions small and comment the *why*.
