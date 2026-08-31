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

import React, { useCallback, useEffect, useRef, useState } from "react"
import WarmupFooter from "./WarmupFooter"
import "./BootScreen.css"

// Loading screen shown while backend/warmup.py pulls the Gemma weights and the
// Moonshine STT/TTS models into RAM. Polls /api/warmup and calls onReady()
// when the backend reports it is done (or when the user skips).
//
// Two things keep this from ever trapping the kiosk:
//  - a hard SKIP_AFTER_MS ceiling, after which we let the UI through anyway
//  - any keypress or tap skips manually (warm-up keeps running in the
//    background; the first translation is just slower again, as before)

const POLL_MS = 400
const SKIP_AFTER_MS = 180000

const BAR_CELLS = 28

function BootScreen({ onReady }) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState("CONNECTING")
  const [steps, setSteps] = useState([])
  const [elapsed, setElapsed] = useState(0)
  const [warning, setWarning] = useState(null)
  const [skippable, setSkippable] = useState(false)

  const doneRef = useRef(false)
  const mountedAtRef = useRef(Date.now())
  // Monotonic guard: with per-step ETA interpolation on the backend, a step
  // finishing faster than predicted could otherwise nudge the bar backwards.
  const maxProgressRef = useRef(0)

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onReady()
  }, [onReady])

  useEffect(() => {
    let timer = null
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch("/api/warmup", { cache: "no-store" })
        if (res.ok) {
          const data = await res.json()
          if (cancelled) return
          const next = Math.max(maxProgressRef.current, data.progress || 0)
          maxProgressRef.current = next
          setProgress(next)
          setMessage(data.message || "LOADING")
          setSteps(data.steps || [])
          setElapsed(data.elapsed || 0)
          if (data.error) setWarning(data.error)
          if (data.status === "ready") {
            // Let the bar visibly land on 100% before handing over.
            setProgress(1)
            setTimeout(finish, 350)
            return
          }
        } else if (res.status === 404) {
          // Backend predates the warm-up endpoint: nothing to wait for.
          finish()
          return
        }
      } catch {
        // Backend not up yet (common in dev, where Vite starts first).
        if (!cancelled) setMessage("WAITING FOR SERVER")
      }

      if (cancelled) return
      if (Date.now() - mountedAtRef.current > SKIP_AFTER_MS) {
        finish()
        return
      }
      timer = setTimeout(poll, POLL_MS)
    }

    poll()
    const skipTimer = setTimeout(() => setSkippable(true), 4000)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(skipTimer)
    }
  }, [finish])

  useEffect(() => {
    if (!skippable) return
    const skip = () => finish()
    window.addEventListener("keydown", skip)
    window.addEventListener("pointerdown", skip)
    return () => {
      window.removeEventListener("keydown", skip)
      window.removeEventListener("pointerdown", skip)
    }
  }, [skippable, finish])

  const filled = Math.round(progress * BAR_CELLS)
  const pct = Math.round(progress * 100)

  return (
    <div className="boot-screen">
      <div className="boot-title">LOADING MODELS</div>

      <div className="boot-bar" role="progressbar" aria-valuenow={pct}>
        {Array.from({ length: BAR_CELLS }, (_, i) => (
          <span
            key={i}
            className={`boot-cell ${i < filled ? "filled" : ""} ${
              i === filled && progress < 1 ? "active" : ""
            }`}
          />
        ))}
      </div>

      <div className="boot-status">
        <span className="boot-message">{message}</span>
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
            {step.seconds != null && (
              <span className="boot-step-time">{step.seconds}s</span>
            )}
          </li>
        ))}
      </ul>

      <WarmupFooter
        elapsed={elapsed}
        warning={warning}
        skippable={skippable}
      />
    </div>
  )
}

export default BootScreen
