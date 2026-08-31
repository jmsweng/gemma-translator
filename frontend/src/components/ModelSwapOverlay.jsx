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

import React, { useEffect, useRef, useState } from "react"
import { requestLanguageWarmup, fetchWarmupStatus } from "../utils/api"
import WarmupFooter from "./WarmupFooter"
import "./BootScreen.css"

// The STT recognizer and TTS engine are per-language and the backend caches
// only MAX_MODELS of each, so moving a lane to a language that is not resident
// means a fresh model load. This asks the backend to do that load as soon as
// the lane settles, and shows a compact panel while it happens instead of
// letting it ambush the next translation.
//
// Rotating the revolver fires a change per keypress, so the request is
// debounced -- only the language you actually land on gets loaded.

const DEBOUNCE_MS = 700
const POLL_MS = 400
// If the backend has not reported a language-phase load this soon after the
// request, everything was already resident and there is nothing to show.
const NOTHING_TO_DO_MS = 1500

function ModelSwapOverlay({ langs }) {
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState("")
  const [steps, setSteps] = useState([])
  const [elapsed, setElapsed] = useState(0)
  const [warning, setWarning] = useState(null)
  const dismissedRef = useRef(false)
  // Monotonic guard so a fast-finishing step cannot nudge the bar backwards.
  const maxRef = useRef(0)
  // Monotonic guard so a fast-finishing step cannot nudge the bar backwards.

  const key = langs.join(",")

  useEffect(() => {
    let cancelled = false
    let pollTimer = null
    dismissedRef.current = false
    setVisible(false)
    setProgress(0)
    setWarning(null)
    setElapsed(0)
    maxRef.current = 0

    const debounce = setTimeout(async () => {
      try {
        await requestLanguageWarmup(langs)
      } catch {
        return
      }
      if (cancelled) return

      const requestedAt = Date.now()
      let sawWork = false

      const poll = async () => {
        if (cancelled) return
        let data
        try {
          data = await fetchWarmupStatus()
        } catch {
          return
        }
        if (cancelled) return

        const working = data.phase === "language" && data.status === "running"
        if (working) {
          sawWork = true
          const next = Math.max(maxRef.current, data.progress || 0)
          maxRef.current = next
          setProgress(next)
          setMessage(data.message || "LOADING MODELS")
          setSteps(data.steps || [])
          setElapsed(data.elapsed || 0)
          if (data.error) setWarning(data.error)
          if (!dismissedRef.current) setVisible(true)
        } else if (sawWork) {
          setProgress(1)
          setTimeout(() => !cancelled && setVisible(false), 300)
          return
        } else if (Date.now() - requestedAt > NOTHING_TO_DO_MS) {
          return
        }
        pollTimer = setTimeout(poll, POLL_MS)
      }

      poll()
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(debounce)
      clearTimeout(pollTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])


  useEffect(() => {
    if (!visible) return
    const dismiss = () => {
      dismissedRef.current = true
      setVisible(false)
    }
    window.addEventListener("keydown", dismiss)
    window.addEventListener("pointerdown", dismiss)
    return () => {
      window.removeEventListener("keydown", dismiss)
      window.removeEventListener("pointerdown", dismiss)
    }
  }, [visible])

  if (!visible) return null

  const filled = Math.round(progress * 20)
  const pct = Math.round(progress * 100)

  return (
    <div className="swap-overlay">
      <div className="swap-panel">
        <div className="swap-title">LOADING SPEECH MODELS</div>
        <div className="boot-bar">
          {Array.from({ length: 20 }, (_, i) => (
            <span
              key={i}
              className={`boot-cell ${i < filled ? "filled" : ""} ${
                i === filled && progress < 1 ? "active" : ""
              }`}
            />
          ))}
        </div>
        <div className="boot-status">
          <span>{message}</span>
          <span className="boot-pct">{pct}%</span>
        </div>
        <ul className="boot-steps">
          {steps.map((step) => (
            <li key={step.id} className={`boot-step ${step.status}`}>
              <span className="boot-step-mark">
                {step.status === "done"
                  ? "[ok]"
                  : step.status === "error"
                    ? "[!!]"
                    : step.status === "running"
                      ? "[..]"
                      : "[  ]"}
              </span>
              <span className="boot-step-label">{step.label}</span>
            </li>
          ))}
        </ul>
        <WarmupFooter elapsed={elapsed} warning={warning} skippable />
      </div>
    </div>
  )
}

export default ModelSwapOverlay
