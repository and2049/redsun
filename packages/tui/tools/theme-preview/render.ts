import { createTestRenderer } from "@opentui/core/testing"
import type { Renderable } from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import { themeMode, upsertTheme, type ThemeDocumentSource } from "../../src/theme"
import { createEventStream, createFetch } from "../../test/fixture/tui-client"
import { SESSION_MARKER, homeFixture, sessionFixture } from "./fixture"

export type Screen = "session" | "home"

export interface Span {
  text: string
  fg: number[]
  bg: number[]
  attributes: number
  width: number
}

export interface Frame {
  cols: number
  rows: number
  lines: { spans: Span[] }[]
}

// Frozen mid-animation: frame 3 of the braille cycle.
const SPINNER_FRAME = 3
const BOOT_TIMEOUT = 60_000

// The spinner element keeps ticking on a shared scheduler even headless, so
// captures would drift between renders. Stop every spinner and pin one frame.
function freezeSpinners(root: Renderable) {
  const stack: Renderable[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    const spinner = node as unknown as {
      frames?: string[]
      stop?: () => void
      _currentFrameIndex?: number
      requestRender?: () => void
    }
    if (Array.isArray(spinner.frames) && typeof spinner.stop === "function" && "_currentFrameIndex" in node) {
      spinner.stop()
      spinner._currentFrameIndex = SPINNER_FRAME % spinner.frames.length
      spinner.requestRender?.()
    }
    for (const child of node.getChildren()) stack.push(child as Renderable)
  }
}

// The theme registry and theme context keep module-level state, so only one
// app may boot at a time.
let queue: Promise<unknown> = Promise.resolve()

export function renderScreen(input: {
  theme: string
  source: ThemeDocumentSource
  screen: Screen
  cols: number
  rows: number
}): Promise<Frame> {
  const result = queue.then(() => render(input))
  queue = result.catch(() => {})
  return result
}

async function render(input: {
  theme: string
  source: ThemeDocumentSource
  screen: Screen
  cols: number
  rows: number
}): Promise<Frame> {
  upsertTheme(input.theme, input.source)
  const setup = await createTestRenderer({ width: input.cols, height: input.rows, useThread: false })
  const events = createEventStream()
  const calls = createFetch(input.screen === "session" ? sessionFixture() : homeFixture(), events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  let task: Promise<unknown> | undefined
  // The app prints a session epilogue to stdout on teardown; keep it out of the
  // server console.
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    const { run } = await import("../../src/app")
    let handedOff!: () => void
    const handoff = new Promise<void>((resolve) => {
      handedOff = resolve
    })
    task = Effect.runPromise(
      run({
        app: { name: "theme-preview", version: "dev", channel: "dev" },
        server: { endpoint: { url: server.url.toString() } },
        config: {
          get: async () => ({ theme: { name: input.theme }, animations: true }),
          update: async () => ({}),
        },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => {
          queueMicrotask(handedOff)
          return {
            renderer: setup.renderer,
            mode: themeMode(input.source, input.theme),
            complete: () => {},
          }
        },
        args: input.screen === "session" ? { sessionID: "preview" } : {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await handoff

    // Data arrives over (local) HTTP, so drive render passes while yielding to
    // the event loop until the screen content settles.
    // Wait for the transcript AND the footer meta (agent/model line arrives on
    // its own fetch) so captures never show a half-loaded footer.
    const predicate = (frame: string) =>
      input.screen === "session"
        ? frame.includes(SESSION_MARKER) && frame.includes("interrupt") && frame.includes("DeepSeek")
        : frame.includes("commands") && frame.includes("DeepSeek")
    const deadline = Date.now() + BOOT_TIMEOUT
    let ready = false
    let last = ""
    while (Date.now() < deadline) {
      await setup.renderOnce()
      last = setup.captureCharFrame()
      if (predicate(last)) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!ready) throw new Error(`timed out waiting for the ${input.screen} screen; last frame:\n${last}`)

    // Labels fade in over ~0.16s tweens; capturing immediately freezes them
    // half-faded (greyed agent/model line and text). Freeze the spinners so
    // their frames stop moving, then keep rendering until the colors settle.
    freezeSpinners(setup.renderer.root)
    const signature = () =>
      JSON.stringify(
        setup.renderer.currentRenderBuffer.getSpanLines().map((line) => line.spans.map((span) => span.fg.toInts())),
      )
    let previous = ""
    for (let pass = 0; pass < 30; pass++) {
      await setup.renderOnce()
      const current = signature()
      if (current === previous) break
      previous = current
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    const buffer = setup.renderer.currentRenderBuffer
    return {
      cols: input.cols,
      rows: input.rows,
      lines: buffer.getSpanLines().map((line) => ({
        spans: line.spans.map((span) => ({
          text: span.text,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
          attributes: span.attributes,
          width: span.width,
        })),
      })),
    }
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    // run() resolves once the renderer is destroyed; swallow teardown errors so
    // a failed render cannot take the server down with an unhandled rejection.
    if (task) await task.catch(() => {})
    process.stdout.write = write
    await server.stop()
  }
}
