// End-to-end check that the dense shell wires the dialog stack into the dock:
// boot the real app on the dense default, open the command palette, and assert
// the picker renders as dock rows directly above the footer rather than as a
// centred modal.
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

test("the dense shell renders pickers inline in the dock, not as a modal", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([SESSION])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
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

    api?.keymap.dispatchCommand("command.palette.show")

    let frame = ""
    for (let attempt = 0; attempt < 10; attempt++) {
      await setup.renderOnce()
      await Bun.sleep(25)
      frame = setup.captureCharFrame()
      if (frame.includes("Commands")) break
    }

    // Inline chrome: title + position counter + esc hint + `❯` filter row.
    expect(frame).toContain("Commands")
    expect(frame).toContain("1/")
    expect(frame).toContain("esc")
    expect(frame).toContain("❯ Search")

    // Inline, not modal: the picker sits immediately above the dock footer.
    // A centred modal would open near the top of a 30-row viewport, leaving a
    // ~20 row gap before the footer.
    const lines = frame.split("\n")
    const picker = lines.findIndex((line) => line.includes("Commands"))
    const footer = lines.findIndex((line) => line.includes("Demo session"))
    expect(picker).toBeGreaterThan(0)
    expect(footer).toBeGreaterThan(picker)
    expect(footer - picker).toBeLessThanOrEqual(11)

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
