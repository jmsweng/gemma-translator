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

import { useState, useRef, useCallback, useEffect } from "react"
import { getMergedSamples, resample, blobToBase64 } from "../utils/audioHelpers"

// Mic capture hook: records raw Float32 PCM via Web Audio, resamples to
// 16 kHz mono, and returns it base64-encoded — the exact payload format
// expected by POST /api/stt (backend/server.py).
//
// The mic stream is "warmed" on first interaction and then kept open, with a
// rolling pre-roll buffer always being filled. Push-to-talk therefore captures
// the moments *before* the key was pressed, which stops Moonshine from seeing
// a hard cut into the first phoneme (a common cause of hallucinated leading
// filler words like "yeah"). The stream is torn down after IDLE_TIMEOUT_MS of
// inactivity so an unattended kiosk isn't holding the audio device open.
//
// ScriptProcessorNode is deprecated but used deliberately: it needs no
// separately-served AudioWorklet module and is fine for short push-to-talk
// clips on the kiosk's Chromium.

const PREROLL_MS = 300
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const BUFFER_SIZE = 4096
const TARGET_SAMPLE_RATE = 16000 // Moonshine STT expects 16 kHz mono

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [micError, setMicError] = useState(null)
  const [analyser, setAnalyser] = useState(null)

  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  const scriptProcessorRef = useRef(null)
  const sinkRef = useRef(null)
  const streamRef = useRef(null)
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE)

  // Rolling pre-roll ring buffer (raw context-rate samples).
  const ringRef = useRef(null)
  const ringWriteRef = useRef(0)
  const ringFilledRef = useRef(0)

  // Samples captured while the push-to-talk key is held.
  const recordedSamplesRef = useRef([])
  const isRecordingRef = useRef(false)

  const idleTimerRef = useRef(null)
  const warmingRef = useRef(null)

  // --- ring buffer helpers -------------------------------------------------

  const writeRing = useCallback((chunk) => {
    const ring = ringRef.current
    if (!ring) return
    const cap = ring.length
    // A chunk longer than the ring can only contribute its tail.
    const src = chunk.length > cap ? chunk.subarray(chunk.length - cap) : chunk
    let write = ringWriteRef.current
    const firstLen = Math.min(src.length, cap - write)
    ring.set(src.subarray(0, firstLen), write)
    if (firstLen < src.length) {
      ring.set(src.subarray(firstLen), 0)
    }
    ringWriteRef.current = (write + src.length) % cap
    ringFilledRef.current = Math.min(ringFilledRef.current + src.length, cap)
  }, [])

  // Read the ring back in chronological order.
  const readRing = useCallback(() => {
    const ring = ringRef.current
    if (!ring) return new Float32Array(0)
    const cap = ring.length
    const filled = ringFilledRef.current
    const out = new Float32Array(filled)
    const start = (ringWriteRef.current - filled + cap) % cap
    const firstLen = Math.min(filled, cap - start)
    out.set(ring.subarray(start, start + firstLen), 0)
    if (firstLen < filled) {
      out.set(ring.subarray(0, filled - firstLen), firstLen)
    }
    return out
  }, [])

  const resetRing = useCallback(() => {
    ringWriteRef.current = 0
    ringFilledRef.current = 0
    if (ringRef.current) ringRef.current.fill(0)
  }, [])

  // --- teardown ------------------------------------------------------------

  const teardown = useCallback(async () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect()
      scriptProcessorRef.current.onaudioprocess = null
      scriptProcessorRef.current = null
    }
    if (sinkRef.current) {
      sinkRef.current.disconnect()
      sinkRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }
    setAnalyser(null)

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close()
      } catch {
        // Context may already be closing; nothing useful to do here.
      }
    }

    ringRef.current = null
    resetRing()
    recordedSamplesRef.current = []
    warmingRef.current = null
  }, [resetRing])

  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      // Never pull the stream out from under an in-flight recording.
      if (isRecordingRef.current) {
        armIdleTimer()
        return
      }
      teardown()
    }, IDLE_TIMEOUT_MS)
  }, [teardown])

  // --- warm-up -------------------------------------------------------------

  // Opens the mic and starts filling the pre-roll ring. Safe to call repeatedly;
  // concurrent calls share one in-flight promise. Call this on the kiosk's first
  // interaction (any keydown) so the first push-to-talk is already warm.
  const warmUp = useCallback(async () => {
    if (audioContextRef.current) {
      armIdleTimer()
      return true
    }
    if (warmingRef.current) return warmingRef.current

    const promise = (async () => {
      setMicError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            // AGC ramping at clip onset distorts exactly the region Moonshine
            // is least confident about.
            autoGainControl: false,
          },
        })
        streamRef.current = stream

        const AudioContext = window.AudioContext || window.webkitAudioContext
        const ctx = new AudioContext()
        audioContextRef.current = ctx
        if (ctx.state === "suspended") {
          await ctx.resume()
        }
        sampleRateRef.current = ctx.sampleRate || TARGET_SAMPLE_RATE

        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source

        // Small FFT — the analyser only feeds the low-res bar visualizer.
        const an = ctx.createAnalyser()
        an.fftSize = 256
        analyserRef.current = an
        source.connect(an)
        setAnalyser(an)

        ringRef.current = new Float32Array(
          Math.max(
            BUFFER_SIZE,
            Math.ceil((PREROLL_MS / 1000) * sampleRateRef.current),
          ),
        )
        resetRing()

        const scriptProcessor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1)
        scriptProcessorRef.current = scriptProcessor
        scriptProcessor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0)
          if (isRecordingRef.current) {
            recordedSamplesRef.current.push(new Float32Array(inputData))
          } else {
            writeRing(inputData)
          }
        }

        // A muted sink keeps the processor firing without routing mic audio
        // back out to the speaker.
        const sink = ctx.createGain()
        sink.gain.value = 0
        sinkRef.current = sink
        source.connect(scriptProcessor)
        scriptProcessor.connect(sink)
        sink.connect(ctx.destination)

        armIdleTimer()
        return true
      } catch (err) {
        console.error("Error accessing microphone:", err)
        const msg =
          err.message ||
          "Microphone access failed (HTTPS required for remote devices)"
        setMicError(msg)
        await teardown()
        return false
      } finally {
        warmingRef.current = null
      }
    })()

    warmingRef.current = promise
    return promise
  }, [armIdleTimer, resetRing, teardown, writeRing])

  // --- record / stop -------------------------------------------------------

  const startRecording = useCallback(async () => {
    const ok = await warmUp()
    if (!ok) return false

    // Seed the take with the pre-roll so the first phoneme isn't clipped.
    const preroll = readRing()
    recordedSamplesRef.current = preroll.length ? [preroll] : []
    resetRing()

    isRecordingRef.current = true
    setIsRecording(true)
    armIdleTimer()
    return true
  }, [armIdleTimer, readRing, resetRing, warmUp])

  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return null

    isRecordingRef.current = false
    setIsRecording(false)
    armIdleTimer()

    const chunks = recordedSamplesRef.current
    recordedSamplesRef.current = []
    resetRing()

    if (chunks.length === 0) {
      console.warn("No audio samples recorded")
      return null
    }

    const mergedSamples = getMergedSamples(chunks)
    const resampledSamples = resample(
      mergedSamples,
      sampleRateRef.current,
      TARGET_SAMPLE_RATE,
    )

    // Guard against sub-300 ms takes — key bounces and accidental taps are
    // where the model is most likely to invent a filler word.
    if (resampledSamples.length < TARGET_SAMPLE_RATE * 0.3) {
      console.warn("Recording too short; discarding")
      return null
    }

    const rawBlob = new Blob([resampledSamples.buffer], {
      type: "application/octet-stream",
    })

    try {
      const base64Data = await blobToBase64(rawBlob)
      return { rawBlob, base64Data }
    } catch (err) {
      console.error("Base64 encoding failed:", err)
      return null
    }
  }, [armIdleTimer, resetRing])

  useEffect(() => {
    return () => {
      isRecordingRef.current = false
      teardown()
    }
  }, [teardown])

  return {
    isRecording,
    startRecording,
    stopRecording,
    warmUp,
    analyser,
    micError,
    setMicError,
  }
}
