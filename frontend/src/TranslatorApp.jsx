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

import React, { useState, useEffect, useRef, useCallback } from "react"
import LanguageLane from "./components/LanguageLane"
import LanguagePicker from "./components/LanguagePicker"
import TouchControls from "./components/TouchControls"
import ResponseDrawer from "./components/ResponseDrawer"
import Visualizer from "./components/Visualizer"
import { useAudioRecorder } from "./hooks/useAudioRecorder"
import {
  transcribeAudio,
  translateText,
  splitTextIntoSpeechChunks,
  warmLanguages,
} from "./utils/api"
import { playBlip } from "./utils/audio-blip"

// Core orchestrator for the two-person kiosk translator.
// Flow: hold a key → record mic (useAudioRecorder) → POST /api/stt (Moonshine)
// → LLM translation via /proxy (Gemma, strict-JSON prompt) → /api/tts playback.

// Languages offered on each lane's revolver; ttsLang selects the backend voice.
// talkLabel is the on-screen push-to-talk prompt, written in that language so
// each person reads their own lane's button. rtl flips the button's direction.
const AVAILABLE_LANGUAGES = [
  {
    code: "ar",
    name: "Arabic",
    voice: "tts",
    ttsLang: "ar",
    talkLabel: "اضغط للتحدث",
    rtl: true,
  },
  {
    code: "en",
    name: "English",
    voice: "tts",
    ttsLang: "en",
    talkLabel: "HOLD TO TALK",
  },
  {
    code: "es",
    name: "Spanish",
    voice: "tts",
    ttsLang: "es",
    talkLabel: "MANTÉN PARA HABLAR",
  },
  {
    code: "ja",
    name: "Japanese",
    voice: "tts",
    ttsLang: "ja",
    talkLabel: "押して話す",
  },
  {
    code: "zh",
    name: "Chinese",
    voice: "tts",
    ttsLang: "zh",
    talkLabel: "按住说话",
  },
  {
    code: "ko",
    name: "Korean",
    voice: "tts",
    ttsLang: "ko",
    talkLabel: "눌러서 말하기",
  },
]

// Translation system prompts. Both demand a bare {"translation": ...} object;
// the simple variant adds a reading-level instruction to the same single pass.
const NORMAL_PROMPT = (src, dst) =>
  `You are a high-performance translator. Your task is to translate text from ${src.name.split(" ")[0]} into ${dst.name.split(" ")[0]}.\nYou MUST format your response as a valid JSON object matching this structure:\n{\n  "translation": "High-quality, natural translation into ${dst.name.split(" ")[0]}"\n}\nDo NOT return anything else except this JSON object. No Markdown block wraps (no \`\`\`json), no introductory text, no conversational text. Start directly with "{" and end directly with "}".`

const SIMPLE_PROMPT = (src, dst) =>
  `You are a high-performance translator. Your task is to translate text from ${src.name.split(" ")[0]} into ${dst.name.split(" ")[0]}.\nSimplify the translation to a 6th-grade reading level: use short sentences, common everyday words, and avoid technical jargon, idioms, or complex grammar, while still preserving the original meaning as accurately as possible.\nYou MUST format your response as a valid JSON object matching this structure:\n{\n  "translation": "High-quality, natural translation into ${dst.name.split(" ")[0]}"\n}\nDo NOT return anything else except this JSON object. No Markdown block wraps (no \`\`\`json), no introductory text, no conversational text. Start directly with "{" and end directly with "}".`

function TranslatorApp({
  config,
  simpleMode = false,
  inputLocked = false,
}) {
  // Read inside the key handlers via a ref so the listener effect's deps
  // don't change when the boot screen goes away.
  const inputLockedRef = useRef(inputLocked)
  inputLockedRef.current = inputLocked

  // UI State
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [activePerson, setActivePerson] = useState(1)
  // Which lane's language picker is open (1, 2, or null). Unused when
  // config.touchLanguageMode is "cycle".
  const [pickerLane, setPickerLane] = useState(null)
  // Lane whose button produced the result on screen; drives which side of the
  // drawer the transcription and translation bubbles sit on.
  const [sourceLane, setSourceLane] = useState(1)

  // Translation State
  const [transcriptionData, setTranscriptionData] = useState({
    source: "",
    text: "— listening —",
  })
  const [translationData, setTranslationData] = useState({
    target: "",
    text: "— waiting —",
  })
  const [metaText, setMetaText] = useState("")

  // Currently-playing TTS audio element (chunked playback chain)
  const onlineAudioPlayerRef = useRef(null)

  // Language Lanes State
  const [lang1Index, setLang1Index] = useState(0)
  const [lang2Index, setLang2Index] = useState(1)
  const [activeLaneRecording, setActiveLaneRecording] = useState(null) // 1 or 2

  // Round-trip confirmation (simple mode). The simplified translation is held
  // back until the speaker confirms the back-translation reads correctly, so
  // nothing is spoken to the listener that the speaker has not vetted.
  const [pendingTranslation, setPendingTranslation] = useState(null)
  const [awaitingApproval, setAwaitingApproval] = useState(false)
  const [isApproved, setIsApproved] = useState(false)


  const { isRecording, startRecording, stopRecording, analyser, micError } =
    useAudioRecorder()

  // Pre-load models for the current lane pair. Debounced so rotating through
  // the language revolver only loads where the user stops.
  useEffect(() => {
    const t = setTimeout(() => {
      warmLanguages([
        AVAILABLE_LANGUAGES[lang1Index].code,
        AVAILABLE_LANGUAGES[lang2Index].code,
      ])
    }, 700)
    return () => clearTimeout(t)
  }, [lang1Index, lang2Index])

  useEffect(() => {
    if (micError) {
      setIsDrawerOpen(true)
      setTranscriptionData({ source: "Microphone", text: "Access Failed" })
      setTranslationData({
        target: "Error",
        text: `${micError} (HTTPS is required when accessing from remote devices)`,
      })
    }
  }, [micError])

  // Current TTS playback session. Each playTTS call gets a fresh one so a
  // stopped or superseded session's pending fetches can't start playing.
  const ttsSessionRef = useRef(null)

  const stopSpeaking = useCallback(() => {
    const session = ttsSessionRef.current
    if (session) {
      session.cancelled = true
      session.urls.forEach((u) => URL.revokeObjectURL(u))
      ttsSessionRef.current = null
    }
    if (onlineAudioPlayerRef.current) {
      onlineAudioPlayerRef.current.pause()
      onlineAudioPlayerRef.current = null
    }
  }, [])

  // Speak text via /api/tts. The text is split into chunks (short first chunk
  // so speech starts fast), and the chunks are synthesized one after another
  // starting immediately, so chunk N+1 is being generated while chunk N plays
  // and there is no gap between them. Requests are made strictly in order:
  // the backend synthesizes one at a time but in no particular order, so
  // firing them all at once could make the first chunk wait behind later ones.
  const playTTS = useCallback(
    (text, targetLang) => {
      if (!text) return
      stopSpeaking()

      const chunks = splitTextIntoSpeechChunks(text)
      if (chunks.length === 0) return

      const session = { cancelled: false, urls: [] }
      ttsSessionRef.current = session

      const fetchChunk = async (chunk) => {
        if (session.cancelled) return null
        const ttsUrl = `/api/tts?text=${encodeURIComponent(chunk)}&lang=${encodeURIComponent(targetLang)}`
        const res = await fetch(ttsUrl)
        if (!res.ok) throw new Error(`TTS ${res.status}`)
        const url = URL.createObjectURL(await res.blob())
        if (session.cancelled) {
          URL.revokeObjectURL(url)
          return null
        }
        session.urls.push(url)
        return url
      }

      // audio[i] resolves to a playable URL for chunk i; each fetch starts
      // when the previous one finishes.
      const audio = []
      let chain = Promise.resolve()
      for (const chunk of chunks) {
        chain = chain.then(() => fetchChunk(chunk))
        audio.push(chain)
      }

      const fail = (e) => {
        if (session.cancelled) return
        console.error("TTS playback error:", e)
        stopSpeaking()
        alert("TTS playback failed. Backend server may be offline.")
      }

      const playChunk = (i) => {
        if (session.cancelled) return
        if (i >= chunks.length) {
          stopSpeaking()
          return
        }
        audio[i]
          .then((url) => {
            if (!url || session.cancelled) return
            const player = new Audio(url)
            player.volume = 1.0
            onlineAudioPlayerRef.current = player
            player.onended = () => playChunk(i + 1)
            player.onerror = () => fail(new Error("audio element error"))
            return player.play()
          })
          .catch(fail)
      }

      playChunk(0)
    },
    [stopSpeaking],
  )

  // Rotate a lane's language, skipping the slot held by the other lane
  // (the two lanes may never show the same language).
  const handleRotateLanguage = useCallback(
    (lane, direction) => {
      if (isRecording) return
      const N = AVAILABLE_LANGUAGES.length

      playBlip("language")

      if (lane === 1) {
        let ni = (lang1Index + direction + N) % N
        if (ni === lang2Index) ni = (ni + direction + N) % N
        setLang1Index(ni)
      } else {
        let ni = (lang2Index + direction + N) % N
        if (ni === lang1Index) ni = (ni + direction + N) % N
        setLang2Index(ni)
      }
    },
    [lang1Index, lang2Index, isRecording],
  )

  // Set a lane to an explicit language. If the other lane already holds it,
  // the two swap rather than colliding (lanes may never match).
  const handleSelectLanguage = useCallback(
    (lane, index) => {
      if (isRecording) return
      playBlip("language")
      if (lane === 1) {
        if (index === lang2Index) setLang2Index(lang1Index)
        setLang1Index(index)
      } else {
        if (index === lang1Index) setLang1Index(lang2Index)
        setLang2Index(index)
      }
      setPickerLane(null)
    },
    [lang1Index, lang2Index, isRecording],
  )

  // Tapping a lane's language readout: open the picker, or just advance to the
  // next language if the kiosk is set to "cycle".
  const handleTapLanguage = useCallback(
    (lane) => {
      if (isRecording) return
      if (config.touchLanguageMode === "cycle") {
        handleRotateLanguage(lane, 1)
      } else {
        playBlip("speaker")
        setPickerLane(lane)
      }
    },
    [config.touchLanguageMode, handleRotateLanguage, isRecording],
  )

  // Recording triggers
  const handleRecordStart = useCallback(
    async (lane) => {
      if (isRecording) return
      stopSpeaking()

      setActivePerson((prev) => {
        if (prev !== lane) playBlip("speaker")
        return lane
      })
      setActiveLaneRecording(lane)
      playBlip("ping")

      const ok = await startRecording()
      if (!ok) {
        setActiveLaneRecording(null)
      }
    },
    [isRecording, stopSpeaking, startRecording],
  )

  const handleRecordStop = useCallback(async () => {
    if (!isRecording) return

    const recordedLane = activeLaneRecording
    setActiveLaneRecording(null)
    const audioData = await stopRecording()

    if (audioData) {
      processTranslation(recordedLane, audioData.base64Data)
    }
  }, [isRecording, activeLaneRecording, stopRecording])

  // Speaker's language and their listener's, for a given lane.
  const laneLanguages = (lane) => ({
    src:
      lane === 1
        ? AVAILABLE_LANGUAGES[lang1Index]
        : AVAILABLE_LANGUAGES[lang2Index],
    dst:
      lane === 1
        ? AVAILABLE_LANGUAGES[lang2Index]
        : AVAILABLE_LANGUAGES[lang1Index],
  })

  // Translation Pipeline: mic audio -> transcription -> translation -> speech.
  const processTranslation = async (lane, base64Data) => {
    setIsDrawerOpen(true)
    setSourceLane(lane)

    const { src, dst } = laneLanguages(lane)

    setTranscriptionData({
      source: `${src.name} (Source)`,
      text: "Analyzing voice input...",
    })
    setTranslationData({
      target: `${dst.name} (Translation)`,
      text: "Translating...",
    })
    setMetaText("")
    setPendingTranslation(null)
    setAwaitingApproval(false)
    setIsApproved(false)

    // 1. Transcription
    let transcribedText
    try {
      setTranscriptionData((prev) => ({ ...prev, text: "Listening..." }))
      transcribedText = await transcribeAudio(base64Data, src.code)
    } catch (err) {
      console.error(err)
      setTranscriptionData((prev) => ({
        ...prev,
        text: "(Transcription failed)",
      }))
      setTranslationData((prev) => ({ ...prev, text: `Error: ${err.message}` }))
      return
    }

    setTranscriptionData((prev) => ({ ...prev, text: transcribedText }))

    if (!transcribedText.trim()) {
      setTranslationData((prev) => ({ ...prev, text: "(No speech detected)" }))
      return
    }

    // 2. Translation. Simple mode folds the plain-language instruction into
    // this same pass, so there is no extra round trip.
    const systemPrompt = simpleMode
      ? SIMPLE_PROMPT(src, dst)
      : NORMAL_PROMPT(src, dst)

    try {
      const result = await translateText(transcribedText, {
        ...config,
        modelName: config.modelName,
        systemPrompt,
      })

      // Plain mode: show it and speak it straight away.
      if (!simpleMode) {
        setTranslationData((prev) => ({ ...prev, text: result.translation }))
        setMetaText(`Duration: ${result.duration}s | Tokens: ${result.tokens}`)
        if (config.enableTts) {
          playTTS(result.translation, dst.ttsLang)
        }
        return
      }

      // 3. Simple mode: translate the simplified result straight back into
      // the speaker's language so they can check that simplifying did not
      // drop or distort anything. Reuses the plain prompt with the languages
      // reversed — the check is worthless if the return leg is simplified
      // too, since that could paper over the very loss being looked for.
      setTranslationData((prev) => ({
        ...prev,
        text: "— checking translation —",
      }))

      let backText = ""
      try {
        const back = await translateText(result.translation, {
          ...config,
          modelName: config.modelName,
          systemPrompt: NORMAL_PROMPT(dst, src),
        })
        backText = back.translation
        setMetaText(
          `Duration: ${(Number(result.duration) + Number(back.duration)).toFixed(2)}s | Tokens: ${result.tokens + back.tokens}`,
        )
      } catch (err) {
        // A failed round trip must not strand the translation. Fall back to
        // confirming against the raw transcription instead.
        console.error(err)
        backText = transcribedText
        setMetaText(
          `Duration: ${result.duration}s | Tokens: ${result.tokens} | round-trip check unavailable`,
        )
      }

      setTranscriptionData({
        source: `${src.name} (Round trip)`,
        text: backText,
      })
      setTranslationData((prev) => ({
        ...prev,
        text: "— confirm to send —",
      }))
      setPendingTranslation({ text: result.translation, ttsLang: dst.ttsLang })
      setAwaitingApproval(true)
    } catch (err) {
      console.error(err)
      setTranslationData((prev) => ({ ...prev, text: `Error: ${err.message}` }))
    }
  }

  // Speaker ticked the box: reveal the held translation and speak it.
  const handleApproveRoundTrip = useCallback(() => {
    if (!pendingTranslation) return
    setIsApproved(true)
    setAwaitingApproval(false)
    setTranslationData((prev) => ({ ...prev, text: pendingTranslation.text }))
    playBlip("speaker")
    if (config.enableTts) {
      playTTS(pendingTranslation.text, pendingTranslation.ttsLang)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTranslation, config.enableTts])

  // Push-to-talk keyboard control (two modes, see README):
  // landscape = one "active person" driven by Space/Z/arrows;
  // vertical   = independent per-lane keys (Z/X for record, arrows and -/+).
  // keydown starts recording, keyup stops — e.repeat guards auto-repeat.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (inputLockedRef.current) return
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      const key = e.key.toLowerCase()

      if (config.keyboardMode === "landscape") {
        if (key === " " || e.key === "Spacebar") {
          e.preventDefault()
          if (!isRecording) {
            playBlip("speaker")
            setActivePerson((p) => (p === 1 ? 2 : 1))
          }
        } else if (key === "z") {
          e.preventDefault()
          if (!e.repeat && !isRecording) handleRecordStart(activePerson)
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          handleRotateLanguage(activePerson, -1)
        } else if (e.key === "ArrowRight") {
          e.preventDefault()
          handleRotateLanguage(activePerson, 1)
        }
      } else {
        if (key === "z") {
          e.preventDefault()
          if (!e.repeat && !isRecording) handleRecordStart(1)
        } else if (key === "x") {
          e.preventDefault()
          if (!e.repeat && !isRecording) handleRecordStart(2)
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          handleRotateLanguage(1, -1)
        } else if (e.key === "ArrowRight") {
          e.preventDefault()
          handleRotateLanguage(1, 1)
        } else if (key === "-" || key === "_") {
          e.preventDefault()
          handleRotateLanguage(2, -1)
        } else if (key === "+" || key === "=") {
          e.preventDefault()
          handleRotateLanguage(2, 1)
        }
      }
    }

    const handleKeyUp = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      const key = e.key.toLowerCase()

      if (config.keyboardMode === "landscape") {
        if (key === "z" && isRecording) handleRecordStop()
      } else {
        if (key === "z" && activeLaneRecording === 1) handleRecordStop()
        if (key === "x" && activeLaneRecording === 2) handleRecordStop()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [
    config.keyboardMode,
    isRecording,
    activePerson,
    activeLaneRecording,
    handleRecordStart,
    handleRecordStop,
    handleRotateLanguage,
  ])

  return (
    <div className="translator-envelope">
      <ResponseDrawer
        isActive={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        transcriptionSource={transcriptionData.source}
        transcriptionText={transcriptionData.text}
        translationTarget={translationData.target}
        translationText={translationData.text}
        metaText={metaText}
        sourceLane={sourceLane}
        awaitingApproval={awaitingApproval}
        isApproved={isApproved}
        onApprove={handleApproveRoundTrip}
      />

      <main className="translator-workspace">
        <div className="languages-container">
          <LanguageLane
            laneId={1}
            laneLabel="1"
            languages={AVAILABLE_LANGUAGES}
            currentIndex={lang1Index}
            isRecording={activeLaneRecording === 1}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 1
            }
            onRotate={(dir) => handleRotateLanguage(1, dir)}
            onTapLanguage={() => handleTapLanguage(1)}
          />
          <LanguageLane
            laneId={2}
            laneLabel="2"
            languages={AVAILABLE_LANGUAGES}
            currentIndex={lang2Index}
            isRecording={activeLaneRecording === 2}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 2
            }
            onRotate={(dir) => handleRotateLanguage(2, dir)}
            onTapLanguage={() => handleTapLanguage(2)}
          />
        </div>

        <TouchControls
          recordingLane={activeLaneRecording}
          lang1={AVAILABLE_LANGUAGES[lang1Index]}
          lang2={AVAILABLE_LANGUAGES[lang2Index]}
          onStart={handleRecordStart}
          onStop={handleRecordStop}
        />

        <Visualizer
          activePerson={activePerson}
          isRecording={isRecording}
          analyser={analyser}
          barsCount={parseInt(config.visualizerBars, 10)}
        />
      </main>

      <LanguagePicker
        laneId={pickerLane}
        languages={AVAILABLE_LANGUAGES}
        currentIndex={pickerLane === 1 ? lang1Index : lang2Index}
        otherIndex={pickerLane === 1 ? lang2Index : lang1Index}
        onSelect={(i) => handleSelectLanguage(pickerLane, i)}
        onClose={() => setPickerLane(null)}
      />

    </div>
  )
}

export default TranslatorApp
