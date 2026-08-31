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

// Shared footer for BootScreen and ModelSwapOverlay so the two warm-up
// screens read identically. Both accept a tap or a keypress, and in both
// cases dismissing only hides the screen -- the backend warm-up thread keeps
// loading either way.

function WarmupFooter({ elapsed = 0, warning = null, skippable = false }) {
  return (
    <div className="boot-footer">
      {warning ? (
        <span className="boot-warning">SOME MODELS DEFERRED</span>
      ) : (
        <span>{elapsed ? `${Math.round(elapsed)}s` : ""}</span>
      )}
      {skippable && (
        <span className="boot-skip">TAP OR PRESS ANY KEY TO SKIP</span>
      )}
    </div>
  )
}

export default WarmupFooter
