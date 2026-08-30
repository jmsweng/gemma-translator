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

// Result panel: transcription and translation bubbles in a chat-style layout,
// with a first-run placeholder before any recording.
//
// The bubbles mirror the hardware: whichever lane's push-to-talk button was
// held gets its transcription on that same side of the screen, and the
// translation lands on the listener's side. sourceLane 1 = left, 2 = right.
export default function ResponseDrawer({
  isActive,
  onClose,
  transcriptionSource,
  transcriptionText,
  translationTarget,
  translationText,
  metaText,
  placeholderText,
  sourceLane = 1,
}) {
  // Determine if we have any data to show (or if the drawer was explicitly activated)
  const hasData = isActive || transcriptionSource !== ""

  const { ref: panelRef, hasMore } = useScrollHint([
    transcriptionText,
    translationText,
    hasData,
  ])

  // A long transcription can push the translation below the fold. Scroll to
  // it as it arrives so the result is never silently off-screen — the
  // listener has no reason to suspect there is more to scroll to.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" })
  }, [translationText])

  const sourceSide = sourceLane === 2 ? "right" : "left"
  const targetSide = sourceLane === 2 ? "left" : "right"

  return (
    <div
      className={`response-drawer ${isActive ? "active" : ""}`}
      id="response-drawer"
    >
      <div className="app-title">GEMLANG-1</div>
      <div
        className="drawer-handle"
        onClick={onClose}
        style={{ display: "none" }}
      ></div>
      <div className="scroll-hint-wrap">
        <div className="chat-panel" ref={panelRef}>
        {!hasData ? (
          <div className="initial-placeholder">
            {placeholderText || "Select languages, push to talk"}
          </div>
        ) : (
          <>
            <div className={`chat-row chat-row-${sourceSide}`}>
              <div className={`chat-bubble bubble-${sourceSide}`}>
                <div className="bubble-label">
                  {transcriptionSource || "LANG 1"}
                </div>
                <div className="bubble-text">
                  {transcriptionText || "— listening —"}
                </div>
              </div>
            </div>
            <div className={`chat-row chat-row-${targetSide}`}>
              <div
                className={`chat-bubble bubble-${targetSide} bubble-translation`}
              >
                <div className="bubble-label">
                  {translationTarget || "LANG 2"}
                </div>
                <div className="bubble-text">
                  {translationText || "— waiting —"}
                </div>
              </div>
            </div>
            <div className="chat-meta">{metaText}</div>
          </>
        )}
        </div>
        {hasMore ? (
          <div className="scroll-hint" aria-hidden="true">
            ▾
          </div>
        ) : null}
      </div>
    </div>
  )
}
