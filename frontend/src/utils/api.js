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
async function requestCompletion(userText, config) {
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

// Expects a system prompt asking for {"translation": ...}.
export async function translateText(transcribedText, config) {
  const result = await requestCompletion(transcribedText, config)
  return {
    translation: extractJsonField(result.content, "translation"),
    duration: result.duration,
    tokens: result.tokens,
  }
}

// Plain-language rewrite, staying in the speaker's own language. Expects a
// system prompt asking for {"simplified": ...}. The result is fed back into
// translateText once the speaker approves it.
export async function simplifyText(transcribedText, config) {
  const result = await requestCompletion(transcribedText, config)
  return {
    simplified: extractJsonField(result.content, "simplified"),
    duration: result.duration,
    tokens: result.tokens,
  }
}

// System prompt for the plain-language pass. languageName is the speaker's
// own language — the rewrite must not translate, only simplify.
export function buildSimplifyPrompt(languageName) {
  const lang = languageName.split(" ")[0]
  return [
    `You rewrite text into simple, plain ${lang}. The input is in ${lang} and your output MUST also be in ${lang}. Do not translate.`,
    `Rules:`,
    `- Use short sentences and the most common everyday words.`,
    `- Remove technical jargon, acronyms, idioms and figures of speech. If a technical idea is essential, explain it in plain words.`,
    `- Keep every fact, number, name, request and question from the original. Do not add new information, opinions or commentary.`,
    `- Aim for the style of Simple English Wikipedia: clear and direct, easy for a non-expert or a language learner to understand.`,
    `- Keep it roughly the same length or shorter than the original.`,
    `You MUST format your response as a valid JSON object matching this structure:`,
    `{\n  "simplified": "The rewritten text in ${lang}"\n}`,
    `Do NOT return anything else except this JSON object. No Markdown block wraps (no \`\`\`json), no introductory text, no conversational text. Start directly with "{" and end directly with "}".`,
  ].join("\n")
}

// Word-safe chunking so each /api/tts request stays under ~`limit` chars.
export function splitTextIntoSpeechChunks(text, limit = 180) {
  const words = text.split(/\s+/)
  const chunks = []
  let currentChunk = ""
  for (const word of words) {
    if ((currentChunk + " " + word).trim().length <= limit) {
      currentChunk = (currentChunk + " " + word).trim()
    } else {
      if (currentChunk) chunks.push(currentChunk)
      currentChunk = word
    }
  }
  if (currentChunk) chunks.push(currentChunk)
  return chunks
}

