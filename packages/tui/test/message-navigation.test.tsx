import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { MouseButtons, createTestRenderer } from "@opentui/core/testing"
import type { SessionMessagePinInfo } from "@opencode/client"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("normal-mode j/k tints the navigated message, f pins it, and right-click opens message actions", async () => {
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
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({ data: [...messages, reply].reverse(), cursor: {} })
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
  const barred = (frame: string) => frame.split("\n").filter((line) => line.includes("┃"))
  const tinted = () => {
    const rows = setup.captureSpans().lines.flatMap((line) => {
      const span = line.spans.find((span) => span.text.includes("Request number"))
      const number = span?.text.match(/Request number (\d+)/)?.[1]
      return span && number ? [{ number: Number(number), bg: JSON.stringify(span.bg) }] : []
    })
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.bg, (counts.get(row.bg) ?? 0) + 1)
    const odd = rows.filter((row) => counts.get(row.bg) === 1)
    return odd.length === 1 && rows.length > 1 ? odd[0]!.number : undefined
  }
  try {
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await setup.waitForFrame((frame) => frame.includes("Final answer from the assistant"), { maxPasses: 200 })
    expect(barred(setup.captureCharFrame())).toEqual([])
    expect(tinted()).toBeUndefined()
    setup.mockInput.pressEscape()
    await setup.waitFor(() => setup.renderer.currentFocusedEditor === null)
    setup.mockInput.pressKey("k")
    await setup.waitFor(() => tinted() !== undefined)
    const start = tinted()!
    setup.mockInput.pressKey("k")
    await setup.waitFor(() => tinted() === start - 1)
    setup.mockInput.pressKey("j")
    await setup.waitFor(() => tinted() === start)
    expect(barred(setup.captureCharFrame())).toEqual([])
    setup.mockInput.pressKey("f")
    await setup.waitFor(() => pins.length === 1)
    expect(pins[0]?.messageID).toBe(`msg_${start}`)
    await setup.waitForFrame((frame) => frame.includes(`Request number ${start} [Pinned]`))
    setup.mockInput.pressKey("2")
    setup.mockInput.pressKey("0")
    setup.mockInput.pressKey("j")
    await setup.waitForFrame(
      (frame) => barred(frame).some((line) => line.includes("Final answer from the assistant")),
      { maxPasses: 200 },
    )
    const bars = barred(setup.captureCharFrame())
    expect(bars).toHaveLength(1)
    expect(bars[0]!.indexOf("┃")).toBe(0)
    const reply = setup
      .captureSpans()
      .lines.find((line) => line.spans.some((span) => span.text.includes("Final answer")))!
    expect(new Set(reply.spans.slice(0, -1).map((span) => JSON.stringify(span.bg))).size).toBe(1)
    expect(tinted()).toBeUndefined()
    setup.mockInput.pressKey("i")
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await setup.waitForVisualIdle()
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
