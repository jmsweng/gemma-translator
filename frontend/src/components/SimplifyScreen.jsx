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

import React, { useEffect } from "react"
import { useScrollHint } from "../hooks/useScrollHint"

// Plain-language screen: hold to talk, the model rewrites what you said into
// simple jargon-free wording in your own language, and APPROVE hands that
// text back to the translator exactly as if it had been spoken.
//
// Purely presentational — TranslatorApp owns the recorder and the pipeline so
// there is only ever one mic session in flight.

const STATUS_LABELS = {
  idle: "HOLD THE BUTTON AND SPEAK",
  recording: "● RECORDING",
  transcribing: "TRANSCRIBING...",
  simplifying: "SIMPLIFYING...",
  ready: "REVIEW, THEN APPROVE",
  error: "ERROR",
}

export default function SimplifyScreen({
  isActive,
  onClose,
  lane,
  onToggleLane,
  language,
  isRecording,
  onRecordStart,
  onRecordStop,
  status,
  heardText,
  simplifiedText,
  errorText,
  onApprove,
  onRedo,
  keyboardEnabled = true,
}) {
  const isBusy = status === "transcribing" || status === "simplifying"
  const canApprove = status === "ready" && simplifiedText.trim() !== ""

  const { ref: bodyRef, hasMore } = useScrollHint([
    heardText,
    simplifiedText,
    status,
  ])

  // Same reasoning as the chat panel: a long dictation can push the rewrite
  // below the fold, and the rewrite is the thing being approved.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    if (simplifiedText) {
      body.scrollTo({ top: body.scrollHeight, behavior: "smooth" })
    } else {
      body.scrollTop = 0
    }
  }, [simplifiedText])

  // Z mirrors the on-screen hold button, matching the main screen's
  // push-to-talk key so the kiosk stays usable without a touchscreen.
  useEffect(() => {
    if (!isActive || !keyboardEnabled) return

    const handleKeyDown = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      if (e.key.toLowerCase() !== "z") return
      e.preventDefault()
      if (!e.repeat && !isRecording && !isBusy) onRecordStart()
    }

    const handleKeyUp = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      if (e.key.toLowerCase() !== "z") return
      e.preventDefault()
      if (isRecording) onRecordStop()
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [
    isActive,
    keyboardEnabled,
    isRecording,
    isBusy,
    onRecordStart,
    onRecordStop,
  ])

  // Pointer capture keeps the release event on the button even if the finger
  // slides off mid-hold, so a recording can never be left running.
  const handleDown = (e) => {
    e.preventDefault()
    if (isBusy) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onRecordStart()
  }

  const handleUp = (e) => {
    e.preventDefault()
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (isRecording) onRecordStop()
  }

  return (
    <div
      className={`simplify-screen ${isActive ? "active" : ""}`}
      style={{ display: isActive ? "flex" : "none" }}
    >
      <header className="overlay-header">
        <h2>PLAIN LANGUAGE</h2>
        <div className="simplify-header-right">
          <button
            className="simplify-speaker-btn"
            onClick={onToggleLane}
            disabled={isRecording || isBusy}
            title="Switch active speaker"
          >
            <span className="simplify-speaker-glyph">⇄</span>
            <span className="simplify-speaker-label">
              P{lane} · {language.name.toUpperCase()}
            </span>
          </button>
          <button className="overlay-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      <div className="scroll-hint-wrap">
        <div className="simplify-body" ref={bodyRef}>
        <div className="simplify-status">
          {status === "error" ? errorText : STATUS_LABELS[status]}
        </div>

        {!heardText && !simplifiedText ? (
          <div className="simplify-hint">
            Say it however you like. It gets rewritten in simple, everyday{" "}
            {language.name} — no jargon — and nothing is translated until you
            approve it.
          </div>
        ) : null}

        {heardText ? (
          <div className="simplify-block">
            <div className="simplify-block-label">HEARD</div>
            <div className="simplify-block-text simplify-heard">
              {heardText}
            </div>
          </div>
        ) : null}

        {simplifiedText ? (
          <div className="simplify-block">
            <div className="simplify-block-label">SIMPLE</div>
            <div
              className="simplify-block-text simplify-result"
              lang={language.code}
              dir={language.rtl ? "rtl" : "ltr"}
            >
              {simplifiedText}
            </div>
          </div>
        ) : null}
        </div>
        {hasMore ? (
          <div className="scroll-hint" aria-hidden="true">
            ▾
          </div>
        ) : null}
      </div>

      <div className="simplify-footer">
        {canApprove ? (
          <>
            <button className="simplify-action-btn" onClick={onRedo}>
              REDO
            </button>
            <button
              className="simplify-action-btn simplify-approve-btn"
              onClick={onApprove}
            >
              ✓ APPROVE
            </button>
          </>
        ) : (
          <button
            className={`simplify-talk-btn ${isRecording ? "recording" : ""}`}
            lang={language.code}
            dir={language.rtl ? "rtl" : "ltr"}
            disabled={isBusy}
            onPointerDown={handleDown}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {isRecording ? "●" : language.talkLabel}
          </button>
        )}
      </div>
    </div>
  )
}
