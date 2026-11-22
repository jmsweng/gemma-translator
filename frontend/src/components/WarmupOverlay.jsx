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

import React, { useEffect, useState } from "react"

// Loading bar for model warm-up. Two looks, driven by the same status:
//   boot     full screen, blocks input until Gemma + both lanes are loaded
//   language small bar over the top of the UI; doesn't block anything, since
//            pressing talk mid-load still works (it just waits for the model)
//
// When a job finishes the bar fills to 100% and lingers briefly so it reads as
// "done" rather than vanishing mid-way.

const LINGER_MS = 600

function formatRemaining(seconds) {
  if (!seconds || seconds < 1) return ""
  if (seconds < 60) return `~${Math.ceil(seconds)}s LEFT`
  return `~${Math.ceil(seconds / 60)}m LEFT`
}

// Swap-bar text in each UI language. The bar shows one line per lane, in that
// lane's language, so both people can read what is loading.
// names[x] = how this language writes language x.
const SWAP_TEXT = {
  en: {
    loading: (x) => `Loading ${x}`,
    ready: "Ready",
    names: { ar: "Arabic", en: "English", es: "Spanish", ja: "Japanese", zh: "Chinese", ko: "Korean" },
  },
  es: {
    loading: (x) => `Cargando ${x}`,
    ready: "Listo",
    names: { ar: "árabe", en: "inglés", es: "español", ja: "japonés", zh: "chino", ko: "coreano" },
  },
  ar: {
    loading: (x) => `جارٍ تحميل ${x}`,
    ready: "جاهز",
    names: { ar: "العربية", en: "الإنجليزية", es: "الإسبانية", ja: "اليابانية", zh: "الصينية", ko: "الكورية" },
    rtl: true,
  },
  ja: {
    loading: (x) => `${x}を読み込み中`,
    ready: "準備完了",
    names: { ar: "アラビア語", en: "英語", es: "スペイン語", ja: "日本語", zh: "中国語", ko: "韓国語" },
  },
  zh: {
    loading: (x) => `正在加载${x}`,
    ready: "已就绪",
    names: { ar: "阿拉伯语", en: "英语", es: "西班牙语", ja: "日语", zh: "中文", ko: "韩语" },
  },
  ko: {
    loading: (x) => `${x} 불러오는 중`,
    ready: "준비 완료",
    names: { ar: "아랍어", en: "영어", es: "스페인어", ja: "일본어", zh: "중국어", ko: "한국어" },
  },
}

// One line of the swap bar, written in `uiLang`, naming the languages loading.
function swapLine(uiLang, loadingCodes, finished) {
  const t = SWAP_TEXT[uiLang] || SWAP_TEXT.en
  if (finished) return { text: t.ready.toLocaleUpperCase(uiLang), rtl: t.rtl }
  const names = loadingCodes.map((c) => t.names[c] || c).join(" + ")
  return { text: t.loading(names).toLocaleUpperCase(uiLang), rtl: t.rtl }
}

function Bar({ progress }) {
  const pct = Math.round(Math.min(Math.max(progress, 0), 1) * 100)
  return (
    <div
      className="warmup-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="warmup-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

function StepMark({ status }) {
  if (status === "done") return <span className="warmup-mark">✓</span>
  if (status === "error") return <span className="warmup-mark">!</span>
  if (status === "running") return <span className="warmup-mark warmup-spin">›</span>
  return <span className="warmup-mark warmup-dim">·</span>
}

function WarmupOverlay({ status, displayProgress, reachable }) {
  // Snapshot of what to draw, held for LINGER_MS after the job finishes.
  const [shown, setShown] = useState(null)

  useEffect(() => {
    if (!reachable) {
      setShown({ phase: "boot", waiting: true })
      return
    }
    if (status?.busy) {
      setShown({ ...status, waiting: false })
      return
    }
    if (!shown) return
    // Job just finished: show it complete, then hide.
    setShown((prev) => prev && { ...prev, finished: true })
    const t = setTimeout(() => setShown(null), LINGER_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, reachable])

  if (!shown) return null

  const progress = shown.finished ? 1 : shown.waiting ? 0 : displayProgress
  const pct = Math.round(progress * 100)

  if (shown.phase === "boot") {
    return (
      <div className="warmup-boot" aria-live="polite">
        <div className="warmup-boot-panel">
          <div className="warmup-title">GEMMA TRANSLATOR</div>
          <div className="warmup-subtitle">
            {shown.waiting ? "STARTING SERVICES…" : shown.finished ? "READY" : "LOADING MODELS"}
          </div>
          <Bar progress={progress} />
          <div className="warmup-meta">
            <span>{shown.waiting ? "" : `${pct}%`}</span>
            <span>{shown.finished || shown.waiting ? "" : formatRemaining(shown.remaining)}</span>
          </div>
          {!shown.waiting && (
            <ul className="warmup-steps">
              {(shown.steps || []).map((st) => (
                <li
                  key={st.id}
                  className={
                    st.status === "pending" && !shown.finished
                      ? "warmup-dim"
                      : st.status === "running" && !shown.finished
                        ? "warmup-running"
                        : ""
                  }
                >
                  <StepMark status={shown.finished && st.status !== "error" ? "done" : st.status} />
                  {st.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  const loadingCodes = (shown.loading_langs || []).map((l) => l.code)
  // Lane order, e.g. ["en", "es"]: line 1 in lane 1's language, line 2 in
  // lane 2's. Older backends don't send langs; fall back to English only.
  const uiLangs = shown.langs?.length ? shown.langs : ["en"]
  const lines = uiLangs.map((l) => ({ lang: l, ...swapLine(l, loadingCodes, shown.finished) }))
  return (
    <div className="warmup-swap" aria-live="polite">
      <div className="warmup-swap-row">
        <div className="warmup-swap-lines">
          {lines.map((ln) => (
            <span
              key={ln.lang}
              lang={ln.lang}
              dir={ln.rtl ? "rtl" : "ltr"}
              className="warmup-swap-label"
            >
              {ln.text}
            </span>
          ))}
        </div>
        <span className="warmup-swap-pct">{pct}%</span>
      </div>
      <Bar progress={progress} />
    </div>
  )
}

export default WarmupOverlay
