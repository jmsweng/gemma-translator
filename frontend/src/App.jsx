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

import React, { useState, useEffect } from "react"
import TranslatorApp from "./TranslatorApp"
import SettingsOverlay from "./components/SettingsOverlay"
import WarmupOverlay from "./components/WarmupOverlay"
import { useWarmup } from "./hooks/useWarmup"
import { testConnectionAPI } from "./utils/api"

// App shell: owns the global config (keyboardMode and themeColor persist in
// localStorage), the settings overlay, and applies the theme by overriding
// the --bg-black CSS variable.
function App() {
  // Global configuration
  const [config, setConfig] = useState({
    endpointUrl: "http://localhost:9379/v1",
    modelName: "gemma4-e2b",
    apiKey: "",
    keyboardMode: localStorage.getItem("keyboardMode") || "landscape",
    touchLanguageMode: localStorage.getItem("touchLanguageMode") || "picker",
    useProxy: true,
    enableTts: true,
    visualizerBars: 16,
    systemPrompt: "Translator mode",
    themeColor: localStorage.getItem("themeColor") || "#ffa500",
  })

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  // Model warm-up progress. While the boot job runs (or the backend isn't up
  // yet) the boot screen covers the UI and push-to-talk keys are ignored.
  const warmup = useWarmup()
  const bootLocked =
    !warmup.reachable ||
    (warmup.status?.busy && warmup.status.phase === "boot")
  // Simple mode: when on, translations are also rewritten to a 6th-grade
  // reading level. It is a sticky mode, not a one-shot action, so the button
  // reflects state rather than triggering something.
  const [simpleMode, setSimpleMode] = useState(false)

  const testConnection = async () => {
    try {
      await testConnectionAPI(
        config.endpointUrl,
        config.useProxy,
        config.apiKey,
      )
    } catch (err) {
      // Ignored: API test failure
    }
  }

  useEffect(() => {
    testConnection()
  }, [])

  useEffect(() => {
    localStorage.setItem("keyboardMode", config.keyboardMode)
  }, [config.keyboardMode])

  useEffect(() => {
    localStorage.setItem("touchLanguageMode", config.touchLanguageMode)
  }, [config.touchLanguageMode])

  useEffect(() => {
    if (config.themeColor) {
      document.documentElement.style.setProperty('--bg-black', config.themeColor)
      localStorage.setItem("themeColor", config.themeColor)
    }
  }, [config.themeColor])

  return (
    <div className="app-container">
      <div className="config-wrap-right" style={{ opacity: 1 }}>
        <button
          className={`config-toggle-btn config-toggle-btn-wide ${
            simpleMode ? "active" : ""
          }`}
          onClick={() => setSimpleMode((prev) => !prev)}
          aria-pressed={simpleMode}
          title={simpleMode ? "Simple language: ON" : "Simple language: OFF"}
        >
          {/* Inline SVG, not an emoji: U+1F4AC is outside DejaVu's coverage
              and the bundled Roboto Mono is a Latin subset, so the emoji renders as
              tofu on a stock Raspberry Pi OS image. currentColor keeps it in
              step with the active-state inversion. */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.6-.7L3 21l1.9-5A8.2 8.2 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" />
            <circle cx="8.8" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="12.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="16.2" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button
          className="config-toggle-btn"
          onClick={() => setIsSettingsOpen(true)}
          title="Settings"
        >
          ⚙️
        </button>
      </div>

      <div style={{ height: '100%' }}>
        <TranslatorApp
          config={config}
          simpleMode={simpleMode}
          inputLocked={bootLocked}
        />
      </div>

      <SettingsOverlay
        isActive={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        setConfig={setConfig}
        onTestConnection={testConnection}
      />

      <WarmupOverlay {...warmup} />
    </div>
  )
}

export default App
