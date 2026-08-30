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

import { useState, useRef, useEffect, useCallback } from "react"

// Reports whether a scroll container still has content below the fold, so a
// caller can render a "more below" arrow.
//
// The kiosk runs with `cursor: none` and Chromium's overlay scrollbars, which
// only paint while a drag is in progress — so there is otherwise no standing
// indication that a long transcription continues past the bottom edge.
//
// `watch` should list the values whose changes can alter the content height
// (the rendered text). A ResizeObserver alone would only catch the container
// being resized, not the text inside it growing.
export function useScrollHint(watch = []) {
  const ref = useRef(null)
  const [hasMore, setHasMore] = useState(false)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 4px slack: sub-pixel rounding otherwise leaves the arrow stuck on when
    // the container is scrolled all the way down.
    setHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    update()
    el.addEventListener("scroll", update, { passive: true })

    // Catches container resize; smooth-scroll animations arrive as a stream
    // of scroll events, which the listener above already handles.
    const observer = new ResizeObserver(update)
    observer.observe(el)

    return () => {
      el.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [update])

  // Re-measure after React has committed new text and the browser has laid
  // it out; measuring in the same tick reads the previous content height.
  useEffect(() => {
    const id = requestAnimationFrame(update)
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, watch)

  return { ref, hasMore }
}
