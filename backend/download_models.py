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

"""Download every Moonshine STT model and TTS voice the server uses.

The kiosk runs offline and server.py loads models lazily, so anything missing
would only fail mid-conversation. Run this while the Pi is online, from the
project venv, as the same user the service runs as (models go to that user's
cache):

    venv/bin/python backend/download_models.py

It reads STT_ARCH, TTS_LANG_MAP and TTS_VOICE_MAP from server.py, so the
downloads always match what the server will ask for. Each model is fetched by
the same library calls the server makes, then closed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402  (importing does not start the HTTP server)
from moonshine_voice import ModelArch, TextToSpeech, get_model_for_language  # noqa: E402


def main():
    failures = []

    for lang in sorted(server.SUPPORTED_STT_LANGS):
        arch = ModelArch[server.STT_ARCH[lang]]
        print(f"[STT] {lang}: {arch.name}", flush=True)
        try:
            path, _ = get_model_for_language(lang, arch)
            print(f"      -> {path}", flush=True)
        except Exception as e:
            failures.append(f"STT {lang} ({arch.name}): {e}")

    for lang, tag in sorted(server.TTS_LANG_MAP.items()):
        voice = server.TTS_VOICE_MAP.get(lang)
        print(f"[TTS] {lang}: {tag}, voice={voice or 'default'}", flush=True)
        try:
            tts = TextToSpeech().language(tag)
            if voice:
                tts = tts.voice(voice)
            tts.load()
            tts.close()
        except Exception as e:
            failures.append(f"TTS {lang} ({tag}, {voice or 'default'}): {e}")

    if failures:
        print("\nSome models could not be downloaded:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("\nAll speech models downloaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
