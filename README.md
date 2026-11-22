<img width="960" height="540" src="https://storage.googleapis.com/experiments-uploads/gemma-translator/gemma-translator.gif" />

# Gemma Translator

This repo was built with the assistance of [Google Antigravity](https://antigravity.google/) and includes code to run an on-device, fully offline voice translator powered by [Gemma 4](https://ai.google.dev/gemma/docs/core) and [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-lm). This project features a web frontend optimized for small handheld displays (e.g., 480x320) and a Python API server (`http.server`) that communicates with Gemma. Speech recognition and text-to-speech are powered by [Moonshine](https://github.com/moonshine-ai/moonshine).

> **This is a fork** of [google-gemma/gemma-translator](https://github.com/google-gemma/gemma-translator). It adds touchscreen controls, a simple-language mode, model warm-up with loading screens, and faster speech output. See [CHANGES_FROM_UPSTREAM.md](CHANGES_FROM_UPSTREAM.md) for the full list of differences.

https://github.com/user-attachments/assets/343072ce-dc78-44a7-a783-99312845cabe

## Features

- **On-Device Inference**: Uses LiteRT-LM to run the `gemma4-e2b` model entirely locally. No internet required after setup.
- **Voice Interface**: Captures microphone audio, processes it, and sends it to the local model.
- **Optimized UI**: Retro-terminal styling custom-built for small hardware screens (like Raspberry Pi displays).
- **Unified Startup**: One script to launch the LLM server, the Python API, and the React frontend.
- **Touchscreen Controls**: Hold-to-talk buttons labelled in each lane's language, and tap-to-change languages, alongside the keyboard controls.
- **Simple-Language Mode**: Optionally simplifies translations to an easy reading level, shows the speaker a back-translation to check, and only speaks once they confirm.
- **No First-Use Delay**: Gemma and the speech models for both lanes are loaded at boot, and a newly selected language is loaded in the background, with loading screens showing progress.
- **Fast Speech Output**: Speech starts after the first sentence is ready and continues without pauses.
- **Readable Results**: The speaker's bubble appears on their side of the screen, and long results scroll to the translation with a "more below" arrow.

## Prerequisites

- Python 3.10+
- Node.js 18+ (20 LTS recommended) & npm — installed automatically by `deploy-pi.sh` on Raspberry Pi OS / Debian
- Linux or macOS

## Required Hardware

- **Compute**: Raspberry Pi 5 with 8GB RAM
- **Audio Input**: Microphone or USB audio capture interface
- **Audio Output**: Speaker or headphone output device
- **Display**: Display monitor or touchscreen (e.g., 480x320 kiosk display)

<img width="3024" height="1672" src="https://storage.googleapis.com/experiments-uploads/gemma-translator/gemma-translator-cad.gif" />

## Setup Instructions

1. **Make Scripts Executable**
   Ensure the setup, download, start, and deployment scripts have execute permissions:
   ```bash
   chmod +x setup.sh download_model.sh start.sh deploy-pi.sh
   ```

2. **Install Dependencies**
   Run the setup script to create a Python virtual environment (`venv`) and install all required packages:
   ```bash
   ./setup.sh
   ```

3. **Download the Model**
   Run the model downloader script to fetch the `gemma4-e2b` model from Hugging Face and import it into LiteRT-LM:
   ```bash
   ./download_model.sh
   ```

## Running the Application

Start all services (LiteRT-LM, the Python API server, and the Vite Web UI) in development mode:
```bash
./start.sh
```

To run in production mode (skipping Vite dev server and serving compiled UI assets from `frontend/dist/` via `backend/server.py` on port 3000):
```bash
./start.sh --prod
```

The application will be accessible at:
- **Web UI (Dev)**: `http://localhost:5173`
- **Web UI (Prod) / API server**: `http://localhost:3000`
- **LiteRT-LM**: `http://localhost:9379`

## Raspberry Pi Appliance Deployment

To deploy as a permanent systemd kiosk service on a Raspberry Pi 5 (8GB):
```bash
./deploy-pi.sh
```
This automated script installs Debian audio/venv packages, sets up the Python environment, builds production UI assets, downloads the LiteRT model, registers the systemd unit from `deploy/gemma-translator.service`, and configures LXDE GUI autostart (`~/.config/lxsession/rpd-x/autostart`) to launch Chromium in kiosk mode pointing to `http://localhost:3000`.

### Updating a deployed device

```bash
cd ~/gemma-translator
git pull
npm --prefix frontend install    # only needed when frontend/package.json changes
npm --prefix frontend run build  # required: start.sh --prod only builds when frontend/dist/ is missing
sudo systemctl restart gemma-translator.service
```

To check which version a device is running, run `git log -1 --oneline`. Run `git fetch && git log --oneline HEAD..origin/main` to list updates it doesn't have yet.

## Model Warm-up and Loading Screens

Out of the box, LiteRT-LM doesn't load Gemma until the first translation request, and Moonshine loads each language's models the first time that language is used. That made the first translation several seconds slower. To avoid it, the API server warms the models up ahead of time:

- **At boot**, it sends Gemma one short throwaway translation and, at the same time, loads speech recognition and text-to-speech for both starting lanes (Arabic and English), running each once. A full-screen loading screen shows a progress bar, the estimated time left, and a checklist of models. Touch and push-to-talk are blocked until loading finishes.
- **When a lane's language changes**, the UI asks the server to load the new language in the background. A small loading bar at the top of the screen shows the message in both lane languages (e.g. "LOADING SPANISH" and "CARGANDO ESPAÑOL"). It doesn't block anything: pressing talk mid-load works, it just waits for the model. If both languages are already loaded, nothing appears.

The server keeps at most two languages loaded per model type (`MAX_MODELS` in `backend/server.py`). Progress estimates are based on how long each model took to load last time, saved in `backend/.warmup_timings.json`, so the bar is only approximate on the very first boot.

Warm-up can be configured with environment variables on the API server:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `WARMUP_ENABLED` | `1` | Set to `0` to turn warm-up off; models then load on first use |
| `WARMUP_LANGS` | `ar,en` | Languages to load at boot (should match the UI's starting lanes) |
| `WARMUP_LLM_MODEL` | `gemma4-e2b` | Model name for the Gemma warm-up; must match the model name in Settings |
| `WARMUP_LLM_URL` | `http://127.0.0.1:9379/v1/chat/completions` | LiteRT-LM endpoint |
| `WARMUP_LLM_WAIT` | `180` | Seconds to keep retrying the Gemma warm-up |

`GET /api/warmup` returns the current loading status as JSON, which is useful for debugging. The server log also prints a `[Warmup] … ready in Xs` line for each model (`journalctl -u gemma-translator -f` on a deployed device).

## Project Structure

- `frontend/` - React (Vite) web frontend (`index.html`, `src/`, styles, and Vite configuration).
- `backend/` - Python API server (`server.py` and `requirements.txt`) for Moonshine STT, moonshine-voice TTS, and model proxying.
- `deploy/` - Parameterizable systemd service unit template (`gemma-translator.service`).
- `stl/` - STL files for 3D printing the hardware case.
- `setup.sh` - Automates Python virtual environment creation and dependency installation.
- `download_model.sh` - Fetches the required LiteRT model.
- `start.sh` - Multi-process launcher supporting `--prod` and development modes.
- `deploy-pi.sh` - One-command Raspberry Pi automated deployment script.
- `CHANGES_FROM_UPSTREAM.md` - What this fork changes compared with the original Google repo.

## Touchscreen Controls

Everything the keyboard does can also be done on the touchscreen:

- **Hold to talk:** each lane has its own button, labelled in that lane's language (e.g. "HOLD TO TALK", "MANTÉN PARA HABLAR"). Hold it while speaking and release to translate. While one lane is recording, the other lane's button is disabled.
- **Change a language:** tap a lane's language name. What happens depends on **Settings (⚙) → Touch Language Mode**:

| Setting value | Behavior |
| :--- | :--- |
| `picker` | Opens a grid of all languages to choose from — default |
| `cycle` | Advances to the next language |

If you pick the language the other lane already has, the two lanes swap. The setting is remembered across restarts (`localStorage` key `touchLanguageMode`).

## Simple-Language Mode

The speech-bubble button at the top right turns simple-language mode on and off. It is off by default and resets to off on restart. While it's on, a banner at the top says so in both lanes' languages.

In this mode, each translation:

1. **is simplified** to roughly a 6th-grade reading level: short sentences, everyday words, no jargon or idioms, with the meaning kept the same;
2. **is translated back** into the speaker's language and shown in their bubble, so they can check that nothing was lost or changed by simplifying;
3. **waits for confirmation:** it is only shown and spoken to the listener after the speaker taps the checkbox next to their bubble.

This takes one extra Gemma request per translation, so results take longer than in normal mode.

## Keyboard Shortcuts

The Gemma Translator supports **two keyboard modes**. Switch between them anytime from the **Settings panel → "Keyboard Mode"** dropdown. The choice is remembered across restarts (stored in the browser's `localStorage` under the key `keyboardMode`).

The app has two lanes (two people facing each other on the kiosk):
- **Lane 1 / Person 1** — the left/top lane.
- **Lane 2 / Person 2** — the right/bottom lane.

Each lane has a rotating language "revolver" and records speech, which is transcribed (Moonshine STT), translated (Gemma), and spoken back in the other lane's language (moonshine-voice TTS).

### Landscape Mode (default) — "active person"
One lane is the **active person** at a time. The active lane is framed with **corner brackets on all four corners**. You drive everything from a single set of keys and switch focus with Space.

| Key | Action | Description |
| :--- | :--- | :--- |
| **Spacebar** | Switch active person | Toggles the active lane (Person 1 ⇄ Person 2). Disabled while recording. |
| **Z** | Record (push-to-talk) | Hold to record the **active** person; release to transcribe & translate. |
| **← Left Arrow** | Previous language | Rotates the **active** person's language backward. |
| **→ Right Arrow** | Next language | Rotates the **active** person's language forward. |

Notes:
- The active lane shows four-corner brackets; while it is recording, the brackets invert to black along with the lane's color reversal.
- Best for one-handed / single-operator use.

### Vertical Mode — "two-hand" (original mapping)
Each lane has its **own dedicated keys** — there is no active-person concept and **no bracket highlight**. Both people can be controlled independently.

| Key | Action | Description |
| :--- | :--- | :--- |
| **Z** | Record — Person 1 (push-to-talk) | Hold to record Lane 1; release to transcribe & translate. |
| **X** | Record — Person 2 (push-to-talk) | Hold to record Lane 2; release to transcribe & translate. |
| **← Left Arrow** | Previous language — Person 1 | Rotates Lane 1's language backward. |
| **→ Right Arrow** | Next language — Person 1 | Rotates Lane 1's language forward. |
| **− Minus** (`_`) | Previous language — Person 2 | Rotates Lane 2's language backward. |
| **+ Plus** (`=`) | Next language — Person 2 | Rotates Lane 2's language forward. |

Notes:
- No corner-bracket selection highlight in this mode.
- Best for two operators, each handling their own side.

### Common behavior (both modes)
- **Input focus guard:** all shortcuts are ignored while focus is on a configuration field (`<input>`, `<textarea>`, or `<select>`) — e.g. when editing the API endpoint or settings.
- **Recording lock:** language rotation is blocked while a recording is in progress.
- **Boot lock:** shortcuts are ignored while the boot loading screen is showing.
- **Touch works too:** every action is also available on the touchscreen (see [Touchscreen Controls](#touchscreen-controls)).

### Switching modes
Open **Settings (⚙)** → **Keyboard Mode** → choose **Landscape** or **Vertical**. The change takes effect immediately and persists on the device.

| Setting value | Mode |
| :--- | :--- |
| `landscape` | Active-person scheme (Space / Z / ← →) — default |
| `vertical` | Two-hand scheme (Z / X / ← → / − +) |

## Credits
Made by a small team at [Google Creative Lab](https://github.com/googlecreativelab):
- [Alan Yam](https://github.com/alanvww)
- [Shashwath Santosh](https://x.com/shashwth)
- [Dan Motzenbecker](https://github.com/dmotz)

Fork changes (touchscreen controls, simple-language mode, warm-up and loading screens, faster speech) by [jmsweng](https://github.com/jmsweng).

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
