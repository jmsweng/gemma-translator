# Changes from upstream

This repo is a fork of [google-gemma/gemma-translator](https://github.com/google-gemma/gemma-translator).
It branched from upstream at `47f9b3b` (Merge pull request #15). Since then
upstream has only updated README links (#25), which are not merged here.

This file lists what the fork adds or changes. The base pipeline is unchanged:
Moonshine STT → Gemma 4 E2B via `litert-lm serve` → moonshine-voice TTS, on a
Raspberry Pi 5 with a 480×320 display.

To see the full code difference:

```bash
git remote add upstream https://github.com/google-gemma/gemma-translator.git
git fetch upstream
git diff 47f9b3b HEAD --stat
```

## Summary

| Area | Upstream | This fork |
|---|---|---|
| Input | Keyboard only | Keyboard plus on-screen touch controls |
| Result bubbles | Speaker always on the left | Speaker's bubble sits on the side of the lane that spoke |
| Long results | Can scroll off-screen unnoticed | Auto-scrolls to the translation and shows a "more below" arrow |
| Simple language | None | Optional mode: simplified translation, round-trip check, confirm before speaking |
| First use | Gemma and non-English models load on first use (seconds of delay) | Models are loaded and warmed at boot and whenever a lane's language changes |
| Loading feedback | None | Boot loading screen and a bilingual loading bar for language swaps |
| Speech output | Up to 180-char chunks, each fetched after the previous one finishes | Short first chunk, chunks fetched ahead, no gaps between them |

## Features

### 1. Touchscreen controls

Upstream was keyboard-only (its README says on-screen touch controls are not
enabled).

- **Hold-to-talk buttons**, one per lane (`components/TouchControls.jsx`),
  alongside the existing Z / X keys. Each button's label is written in that
  lane's language (`talkLabel`, e.g. "MANTÉN PARA HABLAR"); Arabic is laid out
  right to left. Pointer capture keeps a recording from getting stuck if a
  finger slides off the button. While one lane records, the other lane's
  button is disabled.
- **Tapping a lane's language name** either opens a language picker
  (`components/LanguagePicker.jsx`, a 3×2 grid) or advances to the next
  language. If you pick the language the other lane already has, the two
  lanes swap.
- **New setting:** Settings → "Touch Language Mode", either `picker`
  (default) or `cycle`. It is remembered in `localStorage` (`touchLanguageMode`).

### 2. Bubbles follow the speaker

The transcription bubble appears on the side of whichever lane's button was
pressed, and the translation appears on the listener's side
(`ResponseDrawer.jsx`, `sourceLane` prop). Upstream always put the
transcription on the left.

### 3. Long results stay visible

- When a translation arrives, the result panel scrolls to it, so a long
  transcription can't push it out of view.
- A ▾ arrow appears while there is more text below (`hooks/useScrollHint.js`).
  The kiosk hides the cursor, and Chromium's overlay scrollbars only appear
  while scrolling, so without the arrow there is no sign the text continues.

### 4. Simple-language mode

Toggled with the speech-bubble button at the top right. Off by default; not
remembered across restarts.

When it's on, each translation:

1. uses a prompt that also simplifies the result to roughly a 6th-grade
   reading level (`SIMPLE_PROMPT` in `TranslatorApp.jsx`), in the same single
   Gemma call;
2. is translated back into the speaker's language using the normal,
   non-simplifying prompt, and the back-translation is shown in the speaker's
   bubble. This lets the speaker check that simplifying didn't drop or change
   anything;
3. is held back until the speaker taps the checkbox next to their bubble, and
   only then shown and spoken to the listener. If the back-translation fails,
   the speaker confirms against their original transcription instead.

While the mode is on, a banner in the top strip says so, one line per lane in
that lane's language (`simpleLabel`, e.g. "SIMPLE LANGUAGE ON" /
"LENGUAJE SENCILLO ACTIVADO").

The button and checkbox icons are inline SVGs, not emoji or ✓ characters,
because a stock Raspberry Pi OS image lacks those glyphs.

### 5. Model warm-up

**Why upstream's first translation was slow:**

- `litert-lm serve` doesn't load Gemma until the first chat request arrives,
  so the first translation paid for the whole load.
- Moonshine STT/TTS load per language on first use, and the first
  transcription or synthesis after loading has extra one-time setup.
- Upstream pre-loaded only English STT and TTS, without running them, while
  the UI starts on Arabic + English.

**What this fork does** (`backend/server.py`):

- **At boot:** sends one short throwaway translation to Gemma and, at the same
  time, loads STT and TTS for both starting lanes and runs one dummy
  transcription and synthesis on each. The Gemma request uses the same model
  name the UI sends (`gemma4-e2b`); litert-lm reloads the model whenever the
  name changes, so a warm-up under any other name would be wasted.
- **On a language change:** the UI sends the new lane pair to
  `POST /api/warmup` (debounced 700 ms, so flipping through languages only
  loads the one you stop on). The backend loads whatever is missing in the
  background. Before loading, it marks the languages that are staying as
  recently used, so the 2-model-per-type limit (`MAX_MODELS`) unloads the
  language being replaced rather than the one on the other lane.
- **Requests that arrive mid-load are queued:** the newest lane pair replaces
  any older queued one and runs when the current load finishes.
- If any warm-up step fails, that model just loads on first use, as upstream
  did.

### 6. Loading screens

Both are driven by one status source (`hooks/useWarmup.js`) and drawn by
`components/WarmupOverlay.jsx`.

- **Boot screen:** full screen while the boot warm-up runs. It shows a
  progress bar, a percentage, an estimate of the time left, and a checklist
  (Gemma, then speech recognition and voice for each starting language).
  Touch and push-to-talk keys are blocked until loading finishes. If the
  browser opens before the backend is running, it shows "STARTING SERVICES…"
  until the backend answers.
- **Language-swap bar:** a small bar at the top left that doesn't block
  anything. Pressing talk during a load still works; the request just waits
  for the model. The message appears twice, once in each lane's language
  (e.g. "CARGANDO ESPAÑOL" / "LOADING SPANISH"). No bar appears if both
  languages are already loaded.
- **Progress estimates** are based on how long each step took last time,
  saved in `backend/.warmup_timings.json` (git-ignored). The first boot uses
  rough guesses for a Pi 5, so the bar may jump until a boot has been timed.
- **Earlier attempt:** a version with separate boot and swap screens
  (`a09fb57`) was reverted because a status check right after a language
  change could report "ready" before loading had started. This version has
  the backend mark itself busy before it replies to the language-change
  request.

### 7. Faster speech output

Each TTS chunk must be synthesized in full before it plays, so chunk size
determines how long the listener waits (`utils/api.js`, `TranslatorApp.jsx`).

- **Short first chunk:** the first chunk is the first sentence, or its first
  clause if that's over 80 characters, so the voice starts sooner. Later
  chunks grow to at most twice the previous one (up to 180 characters), so
  each finishes synthesizing while the previous one plays.
- **Sentence-aware splitting:** chunks split at sentence ends, including
  Japanese/Chinese 。！？ and Arabic ؟. Upstream split on spaces only, so a
  Japanese or Chinese translation went to TTS as a single chunk however long
  it was.
- **Fetching ahead:** chunks are requested one after another starting
  immediately, rather than each one only after the previous finished playing.
  They are requested strictly in order, because the backend handles one TTS
  request at a time in no fixed order.

In a test with a stub voice that generates audio at 40% of real time, on a
194-character translation, speech started 0.9 s after the translation arrived
instead of 5.0 s, and the pauses between chunks went from 0.5 s to almost
zero. The real speed-up depends on the Pi's voice synthesis speed.

### 8. moonshine-voice 0.1.6

Upgraded from 0.0.65 (`backend/requirements.txt`, `backend/server.py`).

- **TTS loading:** `TextToSpeech(lang, voice=...)` raises `TypeError` since
  0.1.1. The server now uses `TextToSpeech().language(tag).voice(id).load()`.
- **Pinned STT models:** `STT_ARCH` in `server.py` names the model for each
  language, so a later upgrade can't silently change it: en Medium Streaming,
  es/ja Small Streaming, ar Tiny Streaming, ko Tiny (the 0.1.6 defaults), and
  zh Base, which was more accurate than the default Tiny Streaming. 0.0.65
  used Base for es/ja/zh/ar. The choices come from FLEURS clips scored on the
  Pi; the numbers are in the comment above `STT_ARCH`. Chinese (Base) and
  Korean use the non-commercial Moonshine Community License.
- **Transcriber options:** `max_tokens_per_second` is 13.0 for ja/zh/ar and
  26.0 for ko, since the 6.5 default cuts off output in those scripts (13.0
  still cut off Korean). Korean also uses `vad_threshold` 0.6, which stopped
  it inventing a phrase during pauses; other languages keep the default 0.5.
  `STT_VAD_THRESHOLD` overrides `vad_threshold` for all languages, for testing.
- **Eviction and memory:** an evicted model is `close()`d and the server then
  calls glibc's `malloc_trim(0)`, and `start.sh` sets `MALLOC_ARENA_MAX=2`.
  Without these, memory freed on a language swap stayed stranded in
  per-thread malloc arenas: on a Pi 5, `server.py` grew from 1.8 GB to 5.6 GB
  over five passes through all languages, versus about 2.4 GB with the arena
  limit alone.
- **Model pre-download:** models must be re-downloaded (0.1.x only loads
  `.ort` files and changed the voice file layout). `backend/download_models.py`
  fetches every model and voice the server uses; `deploy-pi.sh` runs it.
- **Hashed requirements:** `setup.sh` installs with `--require-hashes`, but
  the file had no hashes, so a clean install failed. `requirements.txt` is now
  generated from `requirements.in` by `pip-compile --generate-hashes` and adds
  `google-crc32c`, a new moonshine-voice dependency.

### 9. Italian output and a scrolling language picker

- **Italian as a listening language:** Italian is in the language list and
  speaks with the `it-it` voice, so others can speak to an Italian listener.
  There is no Italian speech recognition yet, so an Italian lane's talk button
  is disabled and reads SOLO ASCOLTO ("listen only"), and the Z/X keys do
  nothing on that lane. Otherwise the backend would transcribe the audio as
  English.
- **Scrolling picker:** the picker keeps its tile size (two rows of three)
  and scrolls for more. Tiles select on tap rather than on touch-down, so
  swiping to scroll doesn't pick a language, and a ▼ shows when there's more
  below. The Italian tile is marked LISTEN ONLY.

### 10. Cancel a misheard translation

A ✕ button sits next to the speaker's transcript from when it appears until
the translation has been spoken (`ResponseDrawer.jsx`, `TranslatorApp.jsx`).
If speech recognition got it wrong, the speaker taps it (or presses Esc) and
the translation request is aborted, speech is stopped or never starts, and
the bubble shows "— cancelled —". There's no toggle and no added delay: the
transcript appears about a second after release and Gemma takes a few seconds
to translate, which is the window to cancel in. It works in simple mode too,
including while the round-trip check waits for approval. A new recording
replaces one still in flight, so a late reply can't overwrite the newer
result. The backend proxy still waits for litert-lm, so Gemma may finish the
abandoned translation in the background before starting the next one.

## API and configuration added

### `GET /api/warmup`

Returns the current warm-up job. Fields:

| Field | Meaning |
|---|---|
| `job` | Job number |
| `phase` | `boot`, `language` or `idle` |
| `busy` | `true` while a job is running |
| `ready` | `true` when no job is running |
| `progress` | 0–1, time-based estimate |
| `remaining` | Estimated seconds left |
| `elapsed` | Seconds since the job started |
| `label` | The step currently running |
| `steps` | Each step's `id`, `label` and `status` |
| `langs` | The lane pair the job is for, in lane order |
| `loading_langs` | The languages being loaded, as `code` and `name` |
| `error` | The first failed step, if any |

### `POST /api/warmup`

Body: `{"langs": ["es", "en"]}`. Loads whatever is missing for that pair and
returns the same status. If loading starts, the returned status is already
marked busy.

### Environment variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `WARMUP_ENABLED` | `1` | Set to `0` to switch warm-up off; models then load on first use, as upstream |
| `WARMUP_LANGS` | `ar,en` | Languages to warm at boot (the UI's starting lanes) |
| `WARMUP_LLM_MODEL` | `gemma4-e2b` | Model name for the Gemma warm-up; must match the UI's model name |
| `WARMUP_LLM_URL` | `http://127.0.0.1:9379/v1/chat/completions` | litert-lm endpoint |
| `WARMUP_LLM_WAIT` | `180` | Seconds to keep retrying the Gemma warm-up |
| `STT_VAD_THRESHOLD` | unset (library default 0.5) | `vad_threshold` for every STT model; for testing filler-word hallucinations |

## Tried and reverted

These commits are in the history but their changes are not in the current code:

- **Always-on microphone** (`ef031c8`): kept the mic open between presses,
  kept 300 ms of audio from before the button press so filler words weren't
  hallucinated at the start, and timed the mic out after 5 minutes. Reverted
  in `7251bcc`, so the mic is opened on each press, as upstream.
- **Filled talk-button sizing** (`19d617a`): undone in `078ac13`.
- **Separate simplify screen** (`b6be95a`): a standalone screen for
  simplifying a message before translating it. Replaced in `66200e5` by the
  inline simple-language mode described above.
- **Warm-up screens, first attempt** (`a09fb57`): reverted in `68403b7` and
  replaced by features 5 and 6.

## Known gaps

- **README is out of date:** `README.md` is still upstream's. It says touch
  controls are not enabled and doesn't mention simple-language mode, warm-up
  or the new settings.
- **Unreviewed translations:** the non-English UI text added in this fork
  (`talkLabel`, `simpleLabel`, the swap-bar strings in `WarmupOverlay.jsx`)
  hasn't been checked by native speakers.
- **Not measured on the Pi:** the warm-up and speech changes were tested in a
  cloud environment with stub models, not benchmarked on the device.

## Updating a device

```bash
cd ~/gemma-translator
git pull
venv/bin/pip install --require-hashes -r backend/requirements.txt  # when requirements.txt changes
venv/bin/python backend/download_models.py  # while online, when models or voices change
npm --prefix frontend install   # only needed when frontend/package.json changes
npm --prefix frontend run build # required: start.sh --prod only builds when dist/ is missing
sudo systemctl restart gemma-translator.service
```
