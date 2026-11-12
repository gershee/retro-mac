# Architecture

Retro Mac has four processes, all on one machine. They talk over plain HTTP, a WebSocket on `127.0.0.1`, and tmux.

```
Hermes gateway / TUI ──(plugin hooks, HTTP)──▶ display server ──(WebSocket)──▶ kiosk page (Chrome)
        ▲                                         ▲     │
        │ tmux record key (Ctrl-B)                │     └─ Piper TTS, feeds (weather, calendar, cron)
        └──────────── display server ◀── /ptt ────┘
                                                  ▲
                                 wake daemon ─────┘ (wake word / push-to-talk, owns the mic)
```

## Components

**`server/server.py`: display server (aiohttp, 127.0.0.1:8787)**
- `GET /`, the static `web/` files, and `GET /ws`. The WebSocket pushes settings, the dashboard, crew state, voice state, speech audio and stop events to every connected page.
- `POST /speak {agent, text, voice?}`. Text is cleaned for speech (code, URLs and markdown are dropped, long replies are capped) and split into sentences. Each sentence is synthesized with the agent's Piper voice, or a beep-speak fallback, and sent as soon as it is ready, so the first sentence plays while the rest are still rendering.
- `POST /activity {agent, status, label}` updates the crew panel. Stale statuses decay back to idle.
- `POST /event` handles settings and test events (theme, tone, ptt, `force: true` test speech). `POST /attention` sets the alert list.
- Voice endpoints: `/ptt`, `/arm`, `/disarm`, `/voice_state`, `/voice_turn`, `/voice_pending`, `/voice_error`, `/voice_junk`, `/level`. The server follows the voice session's pane in tmux to know whether Hermes is recording, transcribing or working. It sends the record key itself, so the kiosk's Space bar works like a hardware talk button.
- `GET /health` and `GET /house` serve the HOUSE window, which pings the services listed in `config.toml [house]`.

**`server/feeds.py`.** Open-Meteo weather and "what to wear" advice. Agenda rows come from the configured calendar command (JSON events) plus Hermes cron reminders (`$HERMES_HOME/cron/jobs.json`).

**`server/config.py`.** Loads settings in this order: `config.toml`, then `RETRO_MAC_*` environment variables, then `--demo`. **`server/demo.py`** supplies the sample feeds and the scripted crew loop for demo mode.

**`web/`: the kiosk page.** Everything is drawn on one 512×342 canvas and scaled with nearest-neighbor.
- `face.js`: per-agent faces, the mood state machine (time of day, idle time, crew activity, voice state, tone tags), gapless audio scheduling and analyser-driven lip-sync, and keyboard handling.
- `panels.js`: the dashboard cards and their zoomed views.
- `windows.js`: the classic-Mac click-in windows (TODAY, CREW, WEATHER, HOUSE, ALERTS).
- `banner.js`: the voice banner (LISTENING → GOT IT → WORKING → SPEAKING) and the step checklist.

**`hermes-plugin/retro_mac_face/`: Hermes plugin.** Hook handlers enqueue work for a single daemon thread. Every failure is swallowed, so the display can never break agent turns or chat delivery.
- `post_llm_call` → `/speak`
- `pre_llm_call`, `pre_tool_call`, `post_tool_call` → `/activity`, plus human-readable step captions
- `on_interim_message` → spoken narration between tool calls (voice turns only)
- `pre_transcription` + `pre_llm_call` → `/voice_turn` (the only synchronous call, capped at 0.5 s) marks voice turns and injects short spoken-answer rules. `junk.py` blocks whisper hallucinations before any model call.

The agent ID comes from the active Hermes profile home: the default home is `alfred`, and `profiles/scout` and `profiles/maker` are Scout and Maker.

**`voice/`.**
- `voice-session.sh` keeps `hermes --tui` with `/voice on` alive in a tmux session.
- `wake_daemon.py` listens at 16 kHz with sherpa-onnx keyword spotting, or holds no mic at all in push-to-talk mode. On a trigger it tells the server and presses the record key.
- `wake_gate.py` suppresses false wakes: a fire is ignored if it is too quiet, comes right after a face stopped talking, or comes during the cooldown after a junk transcript.

## Design rules

- **Fail open, quietly.** If the display is down, Hermes behaves exactly as if the plugin were not installed.
- **Local only.** Nothing binds to anything except `127.0.0.1`. The only outbound call is to Open-Meteo, and demo mode makes none.
- **Speech wins.** While a face speaks it goes full screen, and Space or Esc always stops it.
- **Never trust a transcript blindly.** Junk is filtered before the model runs, and the mic window closes on its own.

## Tests

The `tests/` scripts start a silent copy of the server on a spare port (`tests/testsrv.py`). They make no sound, call no model and never touch tmux.

```bash
venv/bin/python tests/test_text.py     # speech text cleanup
venv/bin/python tests/test_junk.py     # junk filter, wake gate, plugin blocking
venv/bin/python tests/test_fail.py     # stuck / failed voice turns
FAKE_TUI=1 venv/bin/python tests/testsrv.py server/server.py 8792 &  venv/bin/python tests/test_ptt.py 8792
```
