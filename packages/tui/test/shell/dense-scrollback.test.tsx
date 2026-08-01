// End-to-end check of the dense transcript path: boot the real app on a real
// split-footer renderer, resume a session that already has a turn in it, and
// assert the turn was committed to native terminal scrollback.
//
// This is the only test that exercises boot → session load → committer →
// writers together; the rest of the shell tests drive those pieces directly.
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

const MESSAGES = [
  {
    info: { id: "msg-1", sessionID: "dummy", role: "user", time: { created: 1 } },
    parts: [{ id: "prt-1", sessionID: "dummy", messageID: "msg-1", type: "text", text: "run the tests" }],
  },
  {
    info: {
      id: "msg-2",
      sessionID: "dummy",
      role: "assistant",
      parentID: "dummy",
      mode: "build",
      providerID: "acme",
      modelID: "little-frank",
      time: { created: 2, completed: 2600 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      path: { cwd: directory, root: directory },
      system: [],
    },
    parts: [
      {
        id: "prt-2",
        sessionID: "dummy",
        messageID: "msg-2",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "bun test" },
          output: "1 pass",
          title: "bun test",
          metadata: { output: "1 pass" },
          time: { start: 2, end: 3 },
        },
      },
      {
        id: "prt-3",
        sessionID: "dummy",
        messageID: "msg-2",
        type: "text",
        text: "All green.",
        time: { start: 3, end: 4 },
      },
    ],
  },
]

test("a resumed session commits its transcript to native scrollback", async () => {
  const setup = await createTestRenderer({
    width: 100,
    height: 30,
    useThread: false,
    screenMode: "split-footer",
    footerHeight: 10,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([SESSION])
    if (url.pathname === "/session/dummy") return json(SESSION)
    if (url.pathname === "/session/dummy/message") return json(MESSAGES)
    if (url.pathname.startsWith("/session/dummy/")) return json([])
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

    // The session loads asynchronously and commits are batched, so drain
    // until the transcript shows up.
    let committed = ""
    for (let attempt = 0; attempt < 40; attempt++) {
      await setup.renderOnce()
      await Bun.sleep(25)
      committed += setup.externalOutput.takeText()
      if (committed.includes("All green.")) break
    }

    // Banner, then the user turn, the dense tool record, the assistant text
    // and the turn summary — in that order.
    expect(committed).toContain("❯ run the tests")
    expect(committed).toContain("⏺ Bash(bun test)")
    expect(committed).toContain("All green.")
    expect(committed).toContain("▣ Build · acme/little-frank")
    expect(committed.indexOf("❯ run the tests")).toBeLessThan(committed.indexOf("⏺ Bash"))
    expect(committed.indexOf("⏺ Bash")).toBeLessThan(committed.indexOf("All green."))

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
