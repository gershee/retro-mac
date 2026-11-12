# Install Retro Mac with your AI agent

Paste the prompt below into Hermes Agent, Claude Code, Codex, Cursor or any coding agent that can run terminal commands on the machine where the display should live. The agent installs the repo, shows you the demo, asks you a few questions, then connects it to Hermes if you have it.

---

```text
Install and set up Retro Mac for me: https://github.com/gershee/retro-mac
It is a local 1-bit vintage-Mac "face" display for AI agents (Python server on 127.0.0.1 + a browser kiosk). Read README.md and ARCHITECTURE.md in the repo first and follow them; if anything below conflicts with the README, the README wins.

Rules:
- Keep everything local. The server must only listen on 127.0.0.1. Do not open ports, tunnels or firewall rules.
- Ask me before: installing anything system-wide (Homebrew/apt packages, tmux, whisper), editing my Hermes config, restarting my Hermes gateway (it drops my chat connections for a minute), installing login auto-start, or turning on the microphone.
- Do not put any API keys or passwords in the repo. Retro Mac needs none.
- Show me what you see at each step (command output or a screenshot), and stop and tell me if a step fails instead of guessing.

Steps:
1. Check prerequisites: Python 3.11+, git, a Chromium-based browser. Tell me the OS and what's missing.
2. Clone into ~/retro-mac (or a folder I pick), create the venv and install: `python3 -m venv venv && venv/bin/pip install -r requirements.txt`.
3. Demo first: `./start.sh --demo` (background), wait for `curl -s http://127.0.0.1:8787/health` to answer, then open http://127.0.0.1:8787/ for me and run `venv/bin/python scripts/demo-tour.py` so I can see a face talk. Ask if I like it before going further.
4. Ask me: my city (for the weather panel; look up its latitude, longitude and IANA time zone yourself), whether I want real voices (~190 MB download), whether I use Hermes Agent, whether I want push-to-talk on the Space bar, and whether this machine should run the display full-screen at login.
5. Write config.toml from config.example.toml with my answers. If I want a calendar, help me find or write a small command that prints my events as JSON in the shape described in config.example.toml; keep its credentials outside the repo.
6. Voices: `venv/bin/pip install -r requirements-voice.txt` (Piper TTS, ~300 MB of packages), then `scripts/fetch-models.sh` (add `--stt`/`--wake` only if I want voice input). Mention that two of the three voices are licensed for personal use only (see README "Models and licenses").
7. Restart the server without --demo and check /health plus the page.
8. If I use Hermes: link hermes-plugin/retro_mac_face into my Hermes plugins folder (and each profile I want a face for), add `retro_mac_face` to `plugins.enabled` in the matching config.yaml (back it up first), then ask me before restarting the gateway. Verify by sending the agent a message and checking that the CREW panel shows it working.
9. Optional, only if I said yes: push-to-talk / voice loop (voice/voice-session.sh, voice/wake_daemon.py, `scripts/ptt on`), the full-screen kiosk (`scripts/kiosk.sh`), and auto-start (`scripts/install-autostart.sh`, macOS; it must be run from a normal Terminal window, so give me the exact command if you can't).
10. Finish with `scripts/doctor.sh`, then give me a short summary: what's running, the keys (Space to talk, 1-6 for windows, Esc to stop), how to stop it, and how to uninstall.
```

---

**Uninstall:** `scripts/install-autostart.sh --uninstall`, remove the plugin link and its `plugins.enabled` entry, then delete the folder.
