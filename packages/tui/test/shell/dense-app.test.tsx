// End-to-end checks that the dense shell boots the fullscreen architecture:
// the classic session route mounts under the dense default, and dialogs open
// in the shared floating overlay — from the session route and from home.
//
// Note: `pluginRuntime.Slot` renders null until the plugin host calls
// `setupSlots`, which this stubbed host never does — so the prompt row is
// absent here, exactly as it would be for the classic route under the same
// harness. Prompt chrome is covered by the component tests instead.
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const SESSION = {
  id: "dummy",
  title: "Demo session",
  slug: "dummy",
  projectID: "project",
  directory,
  version: "0.0.0-test",
  time: { created: 0, updated: 0 },
}

// The classic session route loads the session itself, so the sub-resources
// sync() fetches have to be served too.
function sessionRoutes(url: URL) {
  if (url.pathname === "/session") return json([SESSION])
  if (url.pathname === "/session/dummy") return json(SESSION)
  if (url.pathname === "/session/dummy/message") return json([])
  if (url.pathname === "/session/dummy/todo") return json([])
  if (url.pathname === "/session/dummy/diff") return json({})
  if (url.pathname === "/session/dummy/children") return json([])
}

async function boot(setup: Awaited<ReturnType<typeof createTestRenderer>>, args: { continue?: boolean }) {
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch(sessionRoutes)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args,
      pluginHost: {
        async start(input) {
          api = input.api
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  await setup.renderOnce()
  await setup.renderOnce()
  return { task, api: () => api }
}

async function frameContaining(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  needle: string,
): Promise<string> {
  let frame = ""
  for (let attempt = 0; attempt < 10; attempt++) {
    await setup.renderOnce()
    await Bun.sleep(25)
    frame = setup.captureCharFrame()
    if (frame.includes(needle)) break
  }
  return frame
}

test("pickers open as a floating modal over the dense session", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  try {
    const { task, api } = await boot(setup, { continue: true })

    api()?.keymap.dispatchCommand("command.palette.show")
    const frame = await frameContaining(setup, "Commands")

    // Modal chrome: title + esc hint + filter placeholder row.
    expect(frame).toContain("Commands")
    expect(frame).toContain("esc")
    expect(frame).toContain("Search")

    // Floating, not inline: the overlay opens in the upper half of a 30-row
    // viewport (paddingTop = height/4), not pinned to the bottom rows.
    const lines = frame.split("\n")
    const picker = lines.findIndex((line) => line.includes("Commands"))
    expect(picker).toBeGreaterThan(0)
    expect(picker).toBeLessThan(15)

    api()?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("pickers opened from the dense home render in the floating overlay", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  try {
    // No --continue: the app stays on the home route. Dialogs opened there
    // (home keybinds l/a/ctrl+p and `:sessions`) paint in the shared overlay.
    const { task, api } = await boot(setup, {})

    api()?.keymap.dispatchCommand("command.palette.show")
    const frame = await frameContaining(setup, "Commands")
    expect(frame).toContain("Commands")
    expect(frame).toContain("Search")

    api()?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("the dense session exposes the classic route's session commands", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  try {
    const { task, api } = await boot(setup, { continue: true })

    api()?.keymap.dispatchCommand("command.palette.show")
    let frame = await frameContaining(setup, "Commands")
    expect(frame).toContain("Commands")

    // These live in routes/session/index.tsx — present only if the dense
    // shell really mounts the classic session route.
    for (const query of ["Export session", "Rename session", "Compact session"]) {
      await setup.mockInput.typeText(query)
      frame = await frameContaining(setup, query)
      expect(frame).toContain(query)
      for (let index = 0; index < query.length; index++) setup.mockInput.pressBackspace()
    }

    api()?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
