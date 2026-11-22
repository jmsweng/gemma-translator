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

import { useEffect, useRef, useState } from "react"

// Single source of truth for model warm-up state (GET /api/warmup).
//
// Polls fast while a job is running and slowly when idle. Language swaps are
// picked up instantly too: warmLanguages() in utils/api.js dispatches the
// POST's response as a "warmup-status" window event, and that response is
// already marked busy, so there is no window where a swap looks "ready".
//
// Returns { status, displayProgress, reachable }:
//   status          latest backend status, or null if never reached
//   displayProgress progress that never moves backwards within one job
//   reachable       false while the backend can't be reached and has never
//                   answered (i.e. the kiosk browser came up before server.py)

const BUSY_POLL_MS = 250
const IDLE_POLL_MS = 1000

export function useWarmup() {
  const [status, setStatus] = useState(null)
  const [reachable, setReachable] = useState(true)
  const [displayProgress, setDisplayProgress] = useState(0)
  const everReached = useRef(false)
  const lastJob = useRef(null)
  const busyRef = useRef(false)

  // Fold a new status in, keeping the bar monotonic within a job.
  const apply = (s) => {
    if (!s || typeof s.job !== "number") return
    everReached.current = true
    setReachable(true)
    busyRef.current = !!s.busy
    setStatus(s)
    setDisplayProgress((prev) => {
      if (s.job !== lastJob.current) {
        lastJob.current = s.job
        return s.progress
      }
      return Math.max(prev, s.progress)
    })
  }

  useEffect(() => {
    let cancelled = false
    let timer = null

    const poll = async () => {
      try {
        const res = await fetch("/api/warmup", { cache: "no-store" })
        if (res.ok) {
          apply(await res.json())
        } else if (res.status === 404) {
          // Older backend without warm-up support: behave as if ready.
          everReached.current = true
          setReachable(true)
          busyRef.current = false
          setStatus({ job: -1, busy: false, phase: "idle", progress: 1, steps: [] })
        } else if (!everReached.current) {
          // e.g. 502 from the Vite dev proxy while server.py is still starting.
          setReachable(false)
        }
      } catch {
        if (!everReached.current) setReachable(false)
      }
      if (!cancelled) {
        timer = setTimeout(poll, busyRef.current ? BUSY_POLL_MS : IDLE_POLL_MS)
      }
    }

    const onEvent = (e) => apply(e.detail)
    window.addEventListener("warmup-status", onEvent)
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener("warmup-status", onEvent)
    }
  }, [])

  return { status, displayProgress, reachable }
}
