/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// API client for the Python backend (backend/server.py). LLM calls are
// routed through the backend's /proxy by default so the kiosk stays
// same-origin (no CORS) and works fully offline.

// Normalize a user-entered endpoint into an OpenAI-compatible ".../v1" base.
export function getNormalizedBaseUrl(endpointUrl) {
  let url = endpointUrl.trim()
  if (!url) return "http://localhost:9379/v1"
  url = url.replace(/\/+$/, "")
  if (!url.endsWith("/v1")) {
    url += "/v1"
  }
  return url
}

// Cheap connectivity probe: GET {base}/v1/models.
export async function testConnectionAPI(endpointUrl, useProxy, apiKey) {
  const baseUrl = getNormalizedBaseUrl(endpointUrl)
  const targetUrl = `${baseUrl}/models`

  const headers = {}
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`
  }

  const fetchUrl = useProxy
    ? `/proxy?url=${encodeURIComponent(targetUrl)}`
    : targetUrl

  const response = await fetch(fetchUrl, { method: "GET", headers })
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`)
  }
  return true
}

// Ask the backend to pre-load STT/TTS for the languages the lanes are set to,
// so the first utterance after a language change doesn't pay the model load.
// The response is the warm-up status (already busy if loading started); it is
// broadcast so useWarmup() shows the loading bar without waiting for a poll.
// A failure just means the model loads lazily as before.
export function warmLanguages(langs) {
  fetch("/api/warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ langs }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((status) => {
      if (status) {
        window.dispatchEvent(new CustomEvent("warmup-status", { detail: status }))
      }
    })
    .catch(() => {})
}

// POST base64 Float32 PCM (16 kHz mono) to the local Moonshine STT.
export async function transcribeAudio(base64Data, sourceLangCode) {
  const response = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_base64: base64Data,
      language: sourceLangCode,
    }),
  })

  if (!response.ok) {
    throw new Error(`STT failed: ${response.status}`)
  }

  const sttData = await response.json()
  return sttData.text || ""
}

function generatePayloadJSON(transcribedText, model, systemPrompt) {
  const messages = []
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() })
  }
  messages.push({
    role: "user",
    content: transcribedText,
  })

  return JSON.stringify({ model: model || "gemma4-e2b", messages })
}

// One chat-completions round trip. Callers supply the system prompt (which
// pins the expected JSON shape) and pick the field they want back out.
async function requestCompletion(userText, config, signal) {
  const { endpointUrl, useProxy, apiKey, modelName, systemPrompt } = config
  const baseUrl = getNormalizedBaseUrl(endpointUrl)
  const targetUrl = `${baseUrl}/chat/completions`
  const payload = generatePayloadJSON(userText, modelName, systemPrompt)

  const headers = { "Content-Type": "application/json" }
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`
  }

  const fetchUrl = useProxy
    ? `/proxy?url=${encodeURIComponent(targetUrl)}`
    : targetUrl
  const startRequestTime = Date.now()

  const response = await fetch(fetchUrl, {
    method: "POST",
    headers,
    body: payload,
    signal,
  })
  const requestDuration = ((Date.now() - startRequestTime) / 1000).toFixed(2)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `API ${response.status}: ${errorText || response.statusText}`,
    )
  }

  const data = await response.json()
  let modelResponse = ""
  if (data.choices && data.choices[0] && data.choices[0].message) {
    modelResponse = data.choices[0].message.content || ""
  } else {
    modelResponse = JSON.stringify(data, null, 2)
  }

  return {
    content: modelResponse,
    duration: requestDuration,
    tokens: data.usage?.total_tokens || 0,
  }
}

// The prompts demand a bare JSON object, but we still tolerate ``` fences
// and fall back to the raw reply text if parsing fails.
function extractJsonField(modelResponse, field) {
  try {
    let cleanJson = modelResponse.trim()
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.slice(7)
    }
    if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.slice(3)
    }
    if (cleanJson.endsWith("```")) {
      cleanJson = cleanJson.slice(0, -3)
    }
    cleanJson = cleanJson.trim()

    const parsed = JSON.parse(cleanJson)
    return parsed[field] || ""
  } catch (e) {
    return modelResponse
  }
}

// Expects a system prompt asking for {"translation": ...}. Pass an
// AbortSignal to let the speaker cancel; the fetch then rejects with an
// AbortError. (The backend proxy still waits for litert-lm to finish, so
// Gemma may keep generating the abandoned reply for a few seconds.)
export async function translateText(transcribedText, config, signal) {
  const result = await requestCompletion(transcribedText, config, signal)
  return {
    translation: extractJsonField(result.content, "translation"),
    duration: result.duration,
    tokens: result.tokens,
  }
}

// Speech chunking for /api/tts. Each chunk is synthesized in full before it
// can play, so chunk size is latency:
//   - The first chunk is short (first sentence, or the first clause of a long
//     one) so the voice starts quickly.
//   - Each later chunk is synthesized while the previous one plays, so it can
//     only be about as long as synthesis can keep up with. Chunks therefore
//     grow gradually (at most 2x the previous chunk, up to `limit`) instead of
//     jumping straight to `limit`, which left a pause after the first chunk.
// Sentence ends include CJK and Arabic punctuation, and text with no spaces
// (Japanese, Chinese) is still split; previously such a translation became
// one chunk however long it was.
const SENTENCE_RE = /[^]+?(?:[.!?](?=\s|$)|[。！？؟…]+|$)/gu
const CLAUSE_CHARS = ",;:،、，；："
const CJK_END = /[。！？、，]$/u

// Cut the start off `text`, at most `max` chars: at clause punctuation if
// possible, else a space, else a hard cut. Returns [head, rest].
function takeHead(text, max) {
  if (text.length <= max) return [text, ""]
  const window = text.slice(0, max + 1)
  let cut = -1
  for (let i = window.length - 1; i > max * 0.3; i--) {
    if (CLAUSE_CHARS.includes(window[i])) {
      cut = i + 1
      break
    }
  }
  if (cut < 0) {
    const space = window.lastIndexOf(" ")
    cut = space > max * 0.3 ? space : max
  }
  return [text.slice(0, cut).trim(), text.slice(cut).trim()]
}

export function splitTextIntoSpeechChunks(text, limit = 180, firstLimit = 80) {
  const queue = (text.match(SENTENCE_RE) || [])
    .map((x) => x.trim())
    .filter(Boolean)
  const chunks = []
  const cap = () =>
    chunks.length === 0
      ? firstLimit
      : Math.min(limit, Math.max(firstLimit, 2 * chunks[chunks.length - 1].length))

  let current = ""
  while (queue.length) {
    const sentence = queue.shift()
    const max = cap()
    const sep = current && !CJK_END.test(current) ? " " : ""
    if ((current + sep + sentence).length <= max) {
      current += sep + sentence
      // The first chunk is just the first sentence, never packed.
      if (chunks.length === 0) {
        chunks.push(current)
        current = ""
      }
    } else if (current) {
      // Full: close this chunk and retry the sentence against the next cap.
      chunks.push(current)
      current = ""
      queue.unshift(sentence)
    } else {
      // A single sentence longer than the cap: emit its head, requeue the rest.
      const [head, rest] = takeHead(sentence, max)
      chunks.push(head)
      if (rest) queue.unshift(rest)
    }
  }
  if (current) chunks.push(current)
  return chunks
}
