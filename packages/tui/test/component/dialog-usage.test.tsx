import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { onMount } from "solid-js"
import { DialogUsage } from "../../src/component/dialog-usage"
import { ConfigProvider, Info, resolve } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { LocationProvider, useLocation } from "../../src/context/location"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { createApi, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"

test("usage picker is bottom anchored, hides disconnected providers and persists collapsed sections", async () => {
  let stored: Info = { mouse: false }
  let open = () => {}
  let placement = () => ""
  let pending: Promise<void> | undefined
  let percent = 21
  let accountID = "cred_chatgpt"
  let syncAccounts = async () => {}
  let unavailable = false
  const requests: string[] = []
  const api = createApi(
    createFetch(async (url) => {
      if (url.pathname === "/api/integration")
        return json({
          location: {
            directory: "/project",
            project: { id: "proj_test", directory: "/project", canonical: "/project" },
          },
          data: [
            {
              id: "openai",
              name: "OpenAI",
              methods: [],
              connections: [{ type: "credential", id: accountID, label: "Pro" }],
            },
            { id: "claude-code", name: "Claude Code", methods: [], connections: [] },
            {
              id: "kiro",
              name: "Kiro",
              methods: [],
              connections: [{ type: "credential", id: "cred_kiro", label: "Student" }],
            },
          ],
        })
      if (url.pathname.startsWith("/api/rpc/")) {
        requests.push(url.pathname)
        const kiro = url.pathname.includes("kiro")
        await pending
        return json({
          output: {
            connected: true,
            updatedAt: Date.now(),
            windows: unavailable
              ? []
              : [
                  {
                    id: "limit",
                    label: kiro ? "Monthly" : "Weekly",
                    usedPercent: kiro ? 0.8 : percent,
                    reset: "2026-10-01",
                  },
                ],
            ...(unavailable ? { message: "Could not load usage." } : {}),
          },
        })
      }
    }).fetch,
  )
  function Fixture() {
    const dialog = useDialog()
    const data = useData()
    const location = useLocation()
    open = () => dialog.replace(() => <DialogUsage />)
    placement = () => dialog.placement
    syncAccounts = () => data.location.integration.sync(location.ref)
    onMount(async () => {
      await data.location.integration.sync(location.ref)
      open()
    })
    return <text>Usage test</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={api}>
          <DataProvider directory="/project">
            <LocationProvider>
              <ConfigProvider
                config={resolve(stored, { terminalSuspend: true })}
                service={{
                  get: async () => stored,
                  update: async (update) => {
                    const draft = structuredClone(stored)
                    update(draft)
                    stored = Schema.decodeUnknownSync(Info)(draft)
                    return stored
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
    { width: 90, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("21% used") && frame.includes("0.8% used"))
    expect(placement()).toBe("bottom")
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Claude")
    expect(frame).not.toContain("5-hour")
    expect(frame).toContain("█")
    expect(frame.indexOf("ChatGPT")).toBeLessThan(frame.indexOf("Kiro"))
    const lines = frame.split("\n")
    expect(lines.find((line) => line.includes("Weekly"))!.indexOf("Weekly")).toBe(
      lines.find((line) => line.includes("ChatGPT"))!.indexOf("ChatGPT") + 4,
    )
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const resetColor = spans.find((span) => span.text.includes("Resets"))?.fg.toInts()
    expect(resetColor).toBeDefined()
    expect(resetColor).not.toEqual(spans.find((span) => span.text.includes("Weekly"))?.fg.toInts())
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => !frame.includes("21% used") && frame.includes("0.8% used"))
    expect(stored.usage?.collapsed).toEqual(["openai"])
    expect(stored.mouse).toBe(false)
    const collapsedFrame = app.captureCharFrame()
    expect(collapsedFrame.indexOf("Kiro")).toBeLessThan(collapsedFrame.indexOf("ChatGPT"))
    // Focus follows ChatGPT when collapsing moves it below Kiro.
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("21% used"))
    expect(app.captureCharFrame().indexOf("ChatGPT")).toBeLessThan(app.captureCharFrame().indexOf("Kiro"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => !frame.includes("21% used"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Usage limits"))
    const chatGPTReads = () => requests.filter((url) => url.includes("openai")).length
    const readsBeforeReopen = chatGPTReads()
    const gate = Promise.withResolvers<void>()
    pending = gate.promise
    open()
    await app.waitForFrame((frame) => frame.includes("Usage limits") && frame.includes("0.8% used"))
    expect(app.captureCharFrame()).not.toContain("21% used")
    expect(app.captureCharFrame()).toContain("refreshing…")
    expect(chatGPTReads()).toBe(readsBeforeReopen)
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("21% used"))
    await app.waitFor(() => chatGPTReads() === readsBeforeReopen + 1)
    expect(app.captureCharFrame()).not.toContain("Loading usage")
    percent = 35
    gate.resolve()
    pending = undefined
    await app.waitForFrame((frame) => frame.includes("35% used") && !frame.includes("refreshing…"))
    expect(stored.usage?.collapsed).toEqual([])
    expect(requests.every((url) => !url.includes("claude-code"))).toBe(true)
    unavailable = true
    app.mockInput.pressKey("r")
    await app.waitForFrame((frame) => frame.includes("Showing last available usage") && frame.includes("35% used"))
    unavailable = false
    const switched = Promise.withResolvers<void>()
    pending = switched.promise
    accountID = "cred_other_account"
    await syncAccounts()
    await app.waitForFrame((frame) => frame.includes("Loading usage") && !frame.includes("35% used"))
    percent = 77
    switched.resolve()
    pending = undefined
    await app.waitForFrame((frame) => frame.includes("77% used"))
  } finally {
    app.renderer.destroy()
  }
})
