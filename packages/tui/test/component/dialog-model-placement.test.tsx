// The model selector renders as a compact bottom-anchored menu (like the
// prompt autocomplete popup), not as the centered floating modal other
// pickers use — dense-app.test.tsx covers the centered case.
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-fable-5": {
        id: "claude-fable-5",
        providerID: "anthropic",
        name: "Fable 5",
        release_date: "2026-08-01",
        cost: { input: 3, output: 15 },
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        providerID: "anthropic",
        name: "Sonnet 5",
        release_date: "2026-06-01",
        cost: { input: 3, output: 15 },
      },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-6": {
        id: "gpt-6",
        providerID: "openai",
        name: "GPT-6",
        release_date: "2026-05-01",
        cost: { input: 2, output: 8 },
      },
    },
  },
]

function providerRoutes(url: URL) {
  if (url.pathname === "/config/providers") return json({ providers: PROVIDERS, default: {} })
}

async function boot(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch(providerRoutes)
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
      args: {},
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
  for (let attempt = 0; attempt < 20; attempt++) {
    await setup.renderOnce()
    await Bun.sleep(25)
    frame = setup.captureCharFrame()
    if (frame.includes(needle)) break
  }
  return frame
}

test("the model selector opens as a bottom-anchored menu", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  try {
    const { task, api } = await boot(setup)

    api()?.keymap.dispatchCommand("model.list")
    let frame = await frameContaining(setup, "Providers")

    // Menu chrome: title + esc hint + filter placeholder.
    expect(frame).toContain("Select model")
    expect(frame).toContain("esc")
    expect(frame).toContain("Search")

    // Providers are collapsed toggle rows by default — no models listed.
    expect(frame).toContain("▸ Anthropic")
    expect(frame).toContain("2 models")
    expect(frame).toContain("▸ OpenAI")
    expect(frame).not.toContain("Fable 5")

    // Anchored to the bottom rows of the 30-row viewport, not floating in the
    // upper half like the centered pickers (paddingTop = height/4).
    const lines = frame.split("\n")
    const title = lines.findIndex((line) => line.includes("Select model"))
    expect(title).toBeGreaterThan(15)

    // Enter on the first row (Anthropic) expands just that provider.
    setup.mockInput.pressEnter()
    frame = await frameContaining(setup, "Fable 5")
    expect(frame).toContain("▾ Anthropic")
    expect(frame).toContain("Fable 5")
    expect(frame).toContain("Sonnet 5")
    expect(frame).not.toContain("GPT-6")

    // Typing searches across every model, collapsed or not.
    await setup.mockInput.typeText("gpt")
    frame = await frameContaining(setup, "GPT-6")
    expect(frame).toContain("GPT-6")

    api()?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
