import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionMessagePinInfo, SessionMessageInfo } from "@opencode/client"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test.each([60, 100])(
  "reads, renames, jumps to, and unpins an unloaded message at width %s",
  async (width) => {
    await using state = await tmpdir()
    const setup = await createTestRenderer({ width, height: 35, useThread: false, kittyKeyboard: true })
    setup.renderer.start()
    const sessionID = "ses_pin_ui"
    const old: SessionMessageInfo = {
      id: "msg_old",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      content: [{ type: "text", text: "Important historical answer" }],
      time: { created: 1, completed: 2 },
      finish: "stop",
    }
    let pins: SessionMessagePinInfo[] = [
      {
        sessionID,
        messageID: old.id,
        label: null,
        preview: "Important historical answer",
        role: "assistant",
        created: 2,
        updated: 2,
        messageCreated: 1,
      },
    ]
    let pages = 0
    let reads = 0
    const events = createEventStream()
    const calls = createFetch(async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "proj_test",
            title: "Pin fixture",
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/pin`) return json({ data: pins })
      if (url.pathname === `/api/session/${sessionID}/pin/${old.id}`) {
        if (request.method === "PUT" && !pins.length)
          pins = [
            {
              sessionID,
              messageID: old.id,
              label: null,
              preview: "Important historical answer",
              role: "assistant",
              created: 2,
              updated: 2,
              messageCreated: 1,
            },
          ]
        if (request.method === "PATCH") {
          const body: unknown = await request.json()
          if (
            !body ||
            typeof body !== "object" ||
            !("label" in body) ||
            !(typeof body.label === "string" || body.label === null)
          )
            throw new Error("Invalid label")
          const label = body.label
          pins = pins.map((pin) => ({ ...pin, label }))
        }
        if (request.method === "DELETE") pins = []
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/api/session/${sessionID}/message/${old.id}`) {
        reads++
        return json({ data: old })
      }
      if (url.pathname === `/api/session/${sessionID}/message`) {
        pages++
        if (url.searchParams.has("cursor")) return json({ data: [old], cursor: {} })
        return json({
          data: Array.from({ length: 80 }, (_, index) => ({
            id: `msg_${100 - index}`,
            type: "user",
            text: `Recent request ${100 - index}`,
            time: { created: 100 - index },
          })),
          cursor: { next: "older" },
        })
      }
      if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
        return json({ data: [] })
      return undefined
    }, events)
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({ animations: false }), update: async () => ({}) },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        args: { sessionID },
        log: () => {},
      }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
    )
    const openPins = async () => {
      setup.mockInput.pressKey("p", { ctrl: true })
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
      await setup.mockInput.typeText("Pinned messages")
      await setup.waitForFrame((frame) => frame.includes("Pinned messages"))
      const palette = setup.renderer.currentFocusedEditor
      setup.mockInput.pressEnter()
      await setup.waitForFrame(
        (frame) => frame.includes("Important historical answer") && frame.includes("Pinned messages"),
      )
      await setup.waitFor(
        () =>
          setup.renderer.currentFocusedEditor instanceof InputRenderable &&
          setup.renderer.currentFocusedEditor !== palette,
      )
    }
    try {
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await setup.waitForFrame((frame) => frame.includes("Recent request 100"), { maxPasses: 200 })
      const initialPages = pages
      await openPins()
      expect(pages).toBe(initialPages)
      setup.mockInput.pressEnter()
      await setup.waitFor(() => reads === 1)
      await setup.waitForFrame((frame) => frame.includes("enter jump"))
      expect(reads).toBe(1)
      expect(pages).toBe(initialPages)
      setup.mockInput.pressKey("r")
      await setup.waitForFrame((frame) => frame.includes("Rename pin"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await setup.mockInput.typeText("Architecture decision")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("Architecture decision") && frame.includes("Pinned messages"))
      expect(pins[0]?.label).toBe("Architecture decision")
      setup.mockInput.pressKey("r", { ctrl: true })
      await setup.waitForFrame((frame) => frame.includes("Rename pin"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      setup.mockInput.pressKey("a", { ctrl: true })
      setup.mockInput.pressKey("k", { ctrl: true })
      setup.mockInput.pressEnter()
      await setup.waitForFrame(
        (frame) => frame.includes("Important historical answer") && frame.includes("Pinned messages"),
      )
      expect(pins[0]?.label).toBeNull()
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("enter jump"))
      setup.mockInput.pressEnter()
      await setup.waitForFrame(
        (frame) => frame.includes("Important historical answer") && !frame.includes("enter jump"),
        { maxPasses: 200 },
      )
      expect(pages).toBe(initialPages + 1)
      await openPins()
      setup.mockInput.pressKey("d", { ctrl: true })
      await setup.waitForFrame((frame) => frame.includes("No pinned messages"))
      expect(pins).toEqual([])
      setup.mockInput.pressEscape()
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await setup.waitForFrame((frame) => !frame.includes("No pinned messages"))
      await setup.waitForVisualIdle()
      const lines = setup.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes("Message Actions"))
      expect(row).toBeGreaterThanOrEqual(0)
      await setup.mockMouse.click(lines[row]!.indexOf("Message Actions") + 1, row)
      await setup.waitForFrame((frame) => frame.includes("Pin message"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("Pinned") && !frame.includes("Pin message"))
      expect(pins).toHaveLength(1)
      setup.mockInput.pressKey("p", { ctrl: true })
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
      await setup.mockInput.typeText("Pin message")
      await setup.waitForFrame((frame) => frame.includes("Pin message"))
      setup.mockInput.pressEnter()
      await setup.waitFor(() => pins.length === 0)
    } finally {
      setup.renderer.destroy()
      await task
      await server.stop()
    }
  },
  30000,
)
