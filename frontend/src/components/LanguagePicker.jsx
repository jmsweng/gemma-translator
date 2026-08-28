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

// Full-screen language chooser for touchscreen use. Opened by tapping a
// lane's language readout. Tiles are sized for fingers, not cursors.
export default function LanguagePicker({
  laneId,
  languages,
  currentIndex,
  otherIndex,
  onSelect,
  onClose,
}) {
  if (laneId === null) return null

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
        <div className="language-picker-grid">
          {languages.map((l, i) => (
            <button
              key={l.code}
              className={`language-tile ${i === currentIndex ? "current" : ""} ${
                i === otherIndex ? "taken" : ""
              }`}
              onPointerDown={(e) => {
                e.preventDefault()
                onSelect(i)
              }}
            >
              {l.name.split(" ")[0].toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
