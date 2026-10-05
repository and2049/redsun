import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const { loadTheme, DEFAULT_THEMES } = await import("../src/context/theme")
const dusk = loadTheme(DEFAULT_THEMES.dusk, "dusk").theme

// Where the user message and the shell block sit, and whether each is painted or left as
// the terminal's own background.
async function surfaces(terminalBackground: boolean) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const sessionID = "ses_open"
  const messages = [
    { id: "msg_user", type: "user", text: "Request from the user", time: { created: 1 } },
    {
      id: "msg_shell",
      type: "shell",
      shellID: "shell_1",
      command: "echo shell-command",
      status: "completed",
      exit: 0,
      output: { output: "shell-output" },
      time: { created: 2, completed: 3 },
    },
  ]
  const calls = createFetch(async (url) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "Open surfaces fixture",
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [...messages].reverse(), cursor: {} })
    if (
      url.pathname === `/api/session/${sessionID}/pin` ||
      url.pathname === `/api/session/${sessionID}/inbox` ||
      url.pathname === `/api/session/${sessionID}/permission`
    )
      return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, theme: { name: "dusk", terminal_background: terminalBackground } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  const cell = (needle: string) => {
    const lines = setup.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(needle))
    expect(y, needle).toBeGreaterThanOrEqual(0)
    const x = lines[y]!.indexOf(needle)
    const { bg, fg } = setup.renderer.currentRenderBuffer.buffers
    const index = (y * setup.renderer.width + x) * 4
    return {
      x,
      y,
      painted: bg[index + 1]! >>> 8 === 0,
      // A block's gutter, one column left of its padding.
      gutter: [...fg.subarray(index - 8, index - 5)].map((channel) => channel & 255),
    }
  }
  try {
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await setup.waitForFrame((frame) => frame.includes("shell-output"), { maxPasses: 200 })
    await setup.waitForVisualIdle()
    const user = cell("Request from the user")
    const shell = cell("$ echo shell-command")
    await setup.mockMouse.moveTo(user.x + 2, user.y)
    await setup.waitForVisualIdle()
    const hovered = cell("Request from the user")
    return { user, shell, hovered }
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop(true)
  }
}

test("user messages and blocks are painted while the theme owns the background", async () => {
  const { user, shell, hovered } = await surfaces(false)
  expect(user.painted).toBe(true)
  expect(shell.painted).toBe(true)
  expect(hovered.painted).toBe(true)
  // The gutter is the theme background, invisible against it.
  expect(shell.gutter).toEqual(dusk.background.base.toInts().slice(0, 3))
})

test("user messages and blocks are left open over the terminal background until hovered", async () => {
  const { user, shell, hovered } = await surfaces(true)
  expect(user.painted).toBe(false)
  expect(shell.painted).toBe(false)
  expect(hovered.painted).toBe(true)
  // With no fill to set the block apart, its gutter is a visible bar.
  expect(shell.gutter).not.toEqual(dusk.background.base.toInts().slice(0, 3))
})
