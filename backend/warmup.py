# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Startup warm-up for the translator.

The first translation used to be slow because nothing is loaded until it is
needed: LiteRT-LM only maps the Gemma weights on its first completion, and the
Moonshine STT/TTS models are built lazily inside get_stt_recognizer() /
get_tts_engine(). This module does all of that work in a background thread at
boot and publishes progress on GET /api/warmup so the UI can show a loading bar
before it hands control to the user.

Each step also runs one throwaway inference, not just a constructor call --
that is what forces the weights off the SD card into RAM and gets the first
(usually slowest) graph execution out of the way.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Languages to pre-load, in priority order. Defaults to the two lanes the UI
# starts on (Arabic + English). Note the STT/TTS caches in server.py hold
# MAX_MODELS entries each, so listing more languages than that just causes
# eviction churn -- warm the ones you actually start on.
WARM_LANGS = [
    s.strip() for s in os.environ.get("WARMUP_LANGS", "en,ar").split(",") if s.strip()
]
LLM_URL = os.environ.get("WARMUP_LLM_URL", "http://127.0.0.1:9379/v1/chat/completions")
LLM_MODEL = os.environ.get("WARMUP_MODEL", "gemma4-e2b")
LLM_WAIT_SECONDS = int(os.environ.get("WARMUP_LLM_WAIT", "180"))
ENABLED = os.environ.get("WARMUP_ENABLED", "1") not in ("0", "false", "False")

# Where we remember how long each step took last boot, so the progress bar can
# interpolate with a realistic ETA instead of a guess.
TIMINGS_PATH = os.path.join(BASE_DIR, ".warmup_timings.json")

# Fallback ETAs (seconds) for a first run on a Pi 5. Overwritten by measured
# values as soon as one successful boot has been recorded.
DEFAULT_ETAS = {"llm": 45.0, "stt": 12.0, "tts": 14.0}

_lock = threading.Lock()
_state = {
    "status": "pending",  # pending | running | ready | error
    "phase": "boot",      # boot | language
    "steps": [],
    "started_at": None,
    "finished_at": None,
    "error": None,
}

# Language-swap warm-ups. The UI posts the pair of languages its lanes are
# currently set to; we load anything not already resident. One worker thread
# handles boot first, then services these requests one at a time. A newer
# request supersedes an unstarted older one -- rotating through the language
# revolver fires several in a row and only the last one matters.
_request_event = threading.Event()
_pending_langs = None
_loaded_probe = None


def _load_timings():
    try:
        with open(TIMINGS_PATH, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_timings(timings):
    try:
        with open(TIMINGS_PATH, "w") as f:
            json.dump(timings, f)
    except Exception:
        # Read-only checkout, systemd sandbox, whatever -- ETAs just stay at
        # their defaults. Never let this break startup.
        pass


def _build_steps():
    timings = _load_timings()

    def eta(key, kind):
        return float(timings.get(key, DEFAULT_ETAS[kind]))

    steps = [
        {
            "id": "llm",
            "label": "GEMMA LANGUAGE MODEL",
            "weight": 3.0,
            "eta": eta("llm", "llm"),
            "status": "pending",
        }
    ]
    for lang in WARM_LANGS:
        steps.append(
            {
                "id": f"stt:{lang}",
                "label": f"SPEECH RECOGNITION [{lang.upper()}]",
                "weight": 1.0,
                "eta": eta(f"stt:{lang}", "stt"),
                "status": "pending",
            }
        )
    for lang in WARM_LANGS:
        steps.append(
            {
                "id": f"tts:{lang}",
                "label": f"SPEECH SYNTHESIS [{lang.upper()}]",
                "weight": 1.0,
                "eta": eta(f"tts:{lang}", "tts"),
                "status": "pending",
            }
        )
    return steps


def _set_step(step_id, **fields):
    with _lock:
        for step in _state["steps"]:
            if step["id"] == step_id:
                step.update(fields)
                return


def _warm_llm():
    """Force LiteRT-LM to map the Gemma weights by asking for one token.

    litert-lm binds its port well before the model is usable, so start.sh's
    `nc -z` check returns long before a completion would succeed. We retry
    connection errors until LLM_WAIT_SECONDS elapses.
    """
    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    }
    deadline = time.time() + LLM_WAIT_SECONDS
    last_error = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                LLM_URL,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=max(10, LLM_WAIT_SECONDS)) as resp:
                resp.read()
            return
        except urllib.error.HTTPError as e:
            # Some builds reject max_tokens; drop it once and retry.
            if e.code in (400, 422) and "max_tokens" in payload:
                payload.pop("max_tokens")
                continue
            last_error = f"HTTP {e.code}"
            time.sleep(2)
        except Exception as e:
            last_error = str(e)
            time.sleep(2)
    raise RuntimeError(f"litert-lm not ready: {last_error}")


def _warm_stt(lang, get_stt_recognizer):
    recognizer = get_stt_recognizer(lang)
    # One real (silent) inference: the constructor alone does not trigger the
    # first-run allocation/graph setup that makes translation #1 feel slow.
    silence = np.zeros(16000, dtype=np.float32)
    try:
        recognizer.transcribe_without_streaming(silence, 16000)
    except Exception as e:
        print(f"[Warmup] STT dry-run for {lang} failed (model is still cached): {e}")


def _warm_tts(lang, get_tts_engine):
    engine = get_tts_engine(lang)
    try:
        engine.synthesize("...")
    except Exception as e:
        print(f"[Warmup] TTS dry-run for {lang} failed (engine is still cached): {e}")


def _missing_steps(langs):
    """Steps for the languages in `langs` that are not already in the caches."""
    stt_loaded, tts_loaded = _loaded_probe() if _loaded_probe else (set(), set())
    timings = _load_timings()
    steps = []
    for lang in langs:
        if lang not in stt_loaded:
            steps.append(
                {
                    "id": f"stt:{lang}",
                    "label": f"SPEECH RECOGNITION [{lang.upper()}]",
                    "weight": 1.0,
                    "eta": float(timings.get(f"stt:{lang}", DEFAULT_ETAS["stt"])),
                    "status": "pending",
                }
            )
    for lang in langs:
        if lang not in tts_loaded:
            steps.append(
                {
                    "id": f"tts:{lang}",
                    "label": f"SPEECH SYNTHESIS [{lang.upper()}]",
                    "weight": 1.0,
                    "eta": float(timings.get(f"tts:{lang}", DEFAULT_ETAS["tts"])),
                    "status": "pending",
                }
            )
    return steps


def request_languages(langs):
    """Ask for these languages to be resident. Called from POST /api/warmup/languages.

    Cheap and idempotent: if everything is already loaded this does nothing and
    the UI never shows a swap screen.
    """
    if not ENABLED:
        return
    langs = [l for l in dict.fromkeys(langs) if l]
    if not langs:
        return
    global _pending_langs
    with _lock:
        _pending_langs = langs
    _request_event.set()


def _run_steps(steps, get_stt_recognizer, get_tts_engine):
    """Execute a list of warm-up steps, recording timings as we go."""
    timings = _load_timings()
    failed = None
    for step in steps:
        step_id = step["id"]
        started = time.time()
        _set_step(step_id, status="running", started_at=started)
        print(f"[Warmup] {step['label']}...", flush=True)
        try:
            if step_id == "llm":
                _warm_llm()
            elif step_id.startswith("stt:"):
                _warm_stt(step_id.split(":", 1)[1], get_stt_recognizer)
            elif step_id.startswith("tts:"):
                _warm_tts(step_id.split(":", 1)[1], get_tts_engine)
            elapsed = time.time() - started
            timings[step_id] = round(elapsed, 2)
            _set_step(step_id, status="done", seconds=round(elapsed, 2))
            print(f"[Warmup] {step['label']} ready in {elapsed:.1f}s", flush=True)
        except Exception as e:
            failed = failed or str(e)
            _set_step(step_id, status="error", detail=str(e))
            print(f"[Warmup] {step['label']} FAILED: {e}", flush=True)
    _save_timings(timings)
    return failed


def _serve_language_requests(get_stt_recognizer, get_tts_engine):
    """Worker loop, entered once boot warm-up has finished."""
    global _pending_langs
    while True:
        _request_event.wait()
        _request_event.clear()
        with _lock:
            langs = _pending_langs
            _pending_langs = None
        if not langs:
            continue

        steps = _missing_steps(langs)
        if not steps:
            continue

        with _lock:
            _state["status"] = "running"
            _state["phase"] = "language"
            _state["steps"] = steps
            _state["started_at"] = time.time()
            _state["finished_at"] = None
            _state["error"] = None

        failed = _run_steps(steps, get_stt_recognizer, get_tts_engine)

        with _lock:
            _state["finished_at"] = time.time()
            _state["status"] = "ready"
            _state["error"] = failed


def _run(get_stt_recognizer, get_tts_engine):
    with _lock:
        _state["status"] = "running"
        _state["phase"] = "boot"
        _state["started_at"] = time.time()
        steps = list(_state["steps"])

    failed = _run_steps(steps, get_stt_recognizer, get_tts_engine)

    with _lock:
        _state["finished_at"] = time.time()
        # A failed step is not fatal: the model will simply load lazily on
        # first use, exactly like it did before. Report it, then let the UI in.
        _state["status"] = "ready"
        _state["error"] = failed
    total = _state["finished_at"] - _state["started_at"]
    print(f"[Warmup] Complete in {total:.1f}s", flush=True)

    # Stay alive to service language swaps for the rest of the process.
    _serve_language_requests(get_stt_recognizer, get_tts_engine)


def start(get_stt_recognizer, get_tts_engine, loaded_probe=None):
    """Kick off warm-up in a daemon thread. Safe to call once at boot.

    `loaded_probe` returns (stt_langs, tts_langs) currently in the caches, so
    language-swap requests only load what is genuinely missing.
    """
    global _loaded_probe
    _loaded_probe = loaded_probe
    if not ENABLED:
        with _lock:
            _state["status"] = "ready"
            _state["steps"] = []
        return
    with _lock:
        if _state["status"] != "pending":
            return
        _state["steps"] = _build_steps()
    threading.Thread(
        target=_run,
        args=(get_stt_recognizer, get_tts_engine),
        daemon=True,
        name="warmup",
    ).start()


def status():
    """Snapshot for GET /api/warmup."""
    with _lock:
        steps = [dict(s) for s in _state["steps"]]
        state_status = _state["status"]
        state_phase = _state["phase"]
        started_at = _state["started_at"]
        error = _state["error"]

    now = time.time()
    total_weight = sum(s["weight"] for s in steps) or 1.0
    done_weight = 0.0
    current = None

    for step in steps:
        if step["status"] in ("done", "error"):
            done_weight += step["weight"]
        elif step["status"] == "running":
            current = step
            elapsed = now - step.get("started_at", now)
            eta = max(step.get("eta", 10.0), 1.0)
            # Cap the in-step contribution at 95% so the bar never sits at a
            # full segment while work is still happening.
            done_weight += step["weight"] * min(elapsed / eta, 0.95)

    progress = 1.0 if state_status == "ready" else done_weight / total_weight

    return {
        "status": state_status,
        "phase": state_phase,
        "progress": round(min(max(progress, 0.0), 1.0), 4),
        "message": current["label"] if current else (
            "READY" if state_status == "ready"
            else "FINISHING" if state_status == "running"
            else "INITIALIZING"
        ),
        "elapsed": round(now - started_at, 2) if started_at else 0,
        "error": error,
        "steps": [
            {
                "id": s["id"],
                "label": s["label"],
                "status": s["status"],
                "seconds": s.get("seconds"),
            }
            for s in steps
        ],
    }
