import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { MouseButtons, createTestRenderer } from "@opentui/core/testing"
import type { SessionMessagePinInfo } from "@opencode/client"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("normal-mode j/k marks the navigated message, f pins it, and right-click opens message actions", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const sessionID = "ses_nav"
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `msg_${index}`,
    type: "user",
    text: `Request number ${index}`,
    time: { created: index },
  }))
  const reply = {
    id: "msg_reply",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text: "Final answer from the assistant" }],
    time: { created: 40, completed: 41 },
    finish: "stop",
  }
  const pins: SessionMessagePinInfo[] = []
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "Navigation fixture",
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/pin`) return json({ data: pins })
    const pin = url.pathname.match(new RegExp(`^/api/session/${sessionID}/pin/(.+)$`))
    if (pin && request.method === "PUT") {
      pins.push({
        sessionID,
        messageID: pin[1]!,
        label: null,
        preview: pin[1]!,
        role: "user",
        created: 50,
        updated: 50,
        messageCreated: 1,
      })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [...messages, reply].reverse(), cursor: {} })
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
  const marked = (frame: string) => frame.split("\n").filter((line) => line.startsWith("┃"))
  try {
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await setup.waitForFrame((frame) => frame.includes("Final answer from the assistant"), { maxPasses: 200 })
    expect(marked(setup.captureCharFrame())).toEqual([])
    setup.mockInput.pressEscape()
    await setup.waitFor(() => setup.renderer.currentFocusedEditor === null)
    setup.mockInput.pressKey("k")
    await setup.waitForFrame((frame) => marked(frame).length > 0)
    const number = (lines: string[]) => Number(lines.join("\n").match(/Request number (\d+)/)?.[1] ?? -1)
    const start = number(marked(setup.captureCharFrame()))
    expect(start).toBeGreaterThanOrEqual(0)
    setup.mockInput.pressKey("k")
    await setup.waitForFrame((frame) => number(marked(frame)) === start - 1)
    expect(marked(setup.captureCharFrame()).some((line) => line.includes(`Request number ${start} `))).toBe(false)
    setup.mockInput.pressKey("j")
    await setup.waitForFrame((frame) => number(marked(frame)) === start)
    setup.mockInput.pressKey("f")
    await setup.waitFor(() => pins.length === 1)
    expect(pins[0]?.messageID).toBe(`msg_${start}`)
    await setup.waitForFrame((frame) => frame.includes(`Request number ${start} [Pinned]`))
    setup.mockInput.pressKey("g", { shift: true })
    await setup.waitForFrame((frame) => frame.includes("Final answer from the assistant"))
    setup.mockInput.pressKey("i")
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const lines = setup.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Final answer from the assistant"))
    expect(row).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(lines[row]!.indexOf("Final") + 1, row)
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("Message Actions")
    await setup.mockMouse.click(lines[row]!.indexOf("Final") + 1, row, MouseButtons.RIGHT)
    await setup.waitForFrame((frame) => frame.includes("Message Actions"))
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 30000)
