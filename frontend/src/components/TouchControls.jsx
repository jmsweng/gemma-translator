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

import React from "react"

// On-screen push-to-talk: one hold button per lane, mirroring the Z / X keys.
// Pointer capture keeps the release event on the button even if the finger
// slides off it mid-hold, so a recording can never be left running.
function TalkButton({ lane, language, recordingLane, onStart, onStop }) {
  const isRecording = recordingLane === lane
  const otherBusy = recordingLane !== null && recordingLane !== lane

  const handleDown = (e) => {
    e.preventDefault()
    if (otherBusy) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onStart(lane)
  }

  const handleUp = (e) => {
    e.preventDefault()
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (recordingLane === lane) onStop()
  }

  return (
    <button
      className={`talk-button ${isRecording ? "recording" : ""}`}
      lang={language.code}
      dir={language.rtl ? "rtl" : "ltr"}
      disabled={otherBusy}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isRecording ? "●" : language.talkLabel}
    </button>
  )
}

export default function TouchControls({
  recordingLane,
  lang1,
  lang2,
  onStart,
  onStop,
}) {
  return (
    <div className="touch-controls">
      <TalkButton
        lane={1}
        language={lang1}
        recordingLane={recordingLane}
        onStart={onStart}
        onStop={onStop}
      />
      <TalkButton
        lane={2}
        language={lang2}
        recordingLane={recordingLane}
        onStart={onStart}
        onStop={onStop}
      />
    </div>
  )
}
