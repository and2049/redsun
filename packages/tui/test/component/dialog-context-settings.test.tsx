import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { Config as BackendConfig } from "@opencode/schema/config"
import { Schema } from "effect"
import { onMount } from "solid-js"
import { DialogConfig } from "../../src/component/dialog-config"
import { ConfigProvider, resolve } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { LocationProvider, useLocation } from "../../src/context/location"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { createApi, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"

test("settings show the cache warning and persist global backend choices with save-error recovery", async () => {
  let current: BackendConfig.ContextSettings = { stale_read_deduplication: false, compaction: { strategy: "llm" } }
  const updates: BackendConfig.ContextSettings[] = []
  const locations: (string | null)[] = []
  const workspaces: (string | null)[] = []
  let fail = false
  let uiWrites = 0
  const api = createApi(
    createFetch(async (url, request) => {
      if (url.pathname !== "/api/config/context") return
      locations.push(url.searchParams.get("location[directory]"))
      workspaces.push(url.searchParams.get("location[workspace]"))
      if (request.method === "PATCH") {
        if (fail) return json({ message: "Failed to save context settings" }, { status: 400 })
        const update = Schema.decodeUnknownSync(BackendConfig.ContextSettings)(await request.json())
        updates.push(update)
        current = { ...current, ...update }
      }
      return json(current)
    }).fetch,
  )

  function Fixture() {
    const dialog = useDialog()
    const location = useLocation()
    onMount(() => {
      location.set({ directory: "/active-project", workspaceID: "wrk_context_settings" })
      dialog.replace(() => <DialogConfig current="stale_read_deduplication" />)
    })
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={api}>
          <DataProvider directory="/default-project">
            <LocationProvider>
              <ConfigProvider
                config={resolve({}, { terminalSuspend: true })}
                service={{
                  get: async () => ({}),
                  update: async () => {
                    uiWrites++
                    return {}
                  },
                }}
              >
                <Keymap.Provider>
                  <ThemeProvider source={emptyThemeSource}>
                    <ToastProvider>
                      <DialogProvider>
                        <Fixture />
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </LocationProvider>
          </DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame(
      (frame) => frame.includes("Compaction mode") && frame.includes("LLM") && !frame.includes("loading"),
    )
    expect(app.captureCharFrame()).toContain("Global defaults")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("increase costs")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => /Stale-read deduplication\s+on/.test(frame))
    expect(current.stale_read_deduplication).toBe(true)
    await app.waitForFrame((frame) => /Stale-read deduplication\s+on/.test(frame))
    app.mockInput.pressArrow("left")
    await app.waitFor(() => current.stale_read_deduplication === false)
    await app.waitForFrame((frame) => /Stale-read deduplication\s+off/.test(frame))
    app.mockInput.pressArrow("down")
    await app.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes("inventory only"))
    for (const strategy of ["hybrid", "algorithmic", "llm"] as const) {
      app.mockInput.pressArrow("right")
      await app.waitFor(() => current.compaction?.strategy === strategy)
      await app.renderOnce()
    }
    expect(updates).toEqual([
      { stale_read_deduplication: true },
      { stale_read_deduplication: false },
      { compaction: { strategy: "hybrid" } },
      { compaction: { strategy: "algorithmic" } },
      { compaction: { strategy: "llm" } },
    ])
    fail = true
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("Failed to save context settings"))
    expect(current.compaction?.strategy).toBe("llm")
    fail = false
    app.mockInput.pressArrow("right")
    await app.waitFor(() => current.compaction?.strategy === "hybrid")
    expect(uiWrites).toBe(0)
    expect(locations.length).toBeGreaterThan(1)
    expect(new Set(locations)).toEqual(new Set(["/active-project"]))
    expect(new Set(workspaces)).toEqual(new Set(["wrk_context_settings"]))
  } finally {
    app.renderer.destroy()
  }
})
