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

// Full-screen language chooser for touchscreen use. Opened by tapping a
// lane's language readout. Tiles are sized for fingers, not cursors.
//
// The grid shows two rows of three and scrolls vertically for the rest. Tiles
// select on click rather than pointerdown so that a finger starting a swipe
// to scroll doesn't pick whichever tile it landed on (Chromium suppresses the
// click when the gesture turned into a scroll). The kiosk hides the cursor and
// overlay scrollbars only show mid-drag, so a "more below" arrow marks that
// the list continues.
export default function LanguagePicker(props) {
  if (props.laneId === null) return null
  // Mounted fresh on each open, so useScrollHint attaches to a grid that exists.
  return <PickerPanel {...props} />
}

function PickerPanel({
  laneId,
  languages,
  currentIndex,
  otherIndex,
  onSelect,
  onClose,
}) {
  const { ref: gridRef, hasMore } = useScrollHint([languages.length])

  // Open with the lane's current language in view.
  useEffect(() => {
    gridRef.current?.children[currentIndex]?.scrollIntoView({ block: "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="language-picker" onPointerDown={onClose}>
      <div
        className="language-picker-panel"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="language-picker-header">
          <span>PERSON {laneId} LANGUAGE</span>
          <button className="language-picker-close" onPointerDown={onClose}>
            ✕
          </button>
        </div>
        <div className="scroll-hint-wrap">
          <div className="language-picker-grid" ref={gridRef}>
            {languages.map((l, i) => (
              <button
                key={l.code}
                className={`language-tile ${i === currentIndex ? "current" : ""} ${
                  i === otherIndex ? "taken" : ""
                }`}
                onClick={() => onSelect(i)}
              >
                {l.name.split(" ")[0].toUpperCase()}
                {l.listenOnly && (
                  <span className="language-tile-note">LISTEN ONLY</span>
                )}
              </button>
            ))}
          </div>
          {hasMore && (
            <div className="scroll-hint" aria-hidden="true">
              ▼
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
