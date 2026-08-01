import { afterEach, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { createTranscriptReplay } from "../../src/shell/transcript/replay"
import { createCoverController } from "../../src/shell/cover"
import { noteWriter } from "../../src/shell/scrollback/writers"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"

const active: TestRenderer[] = []
const styles: SyntaxStyle[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
  for (const style of styles.splice(0)) {
    style.destroy()
  }
})

async function setup(terminalTransitions = false) {
  const out = await createTestRenderer({
    width: 80,
    height: 30,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)
  if (terminalTransitions) {
    const internals = out.renderer as unknown as { _terminalIsSetup: boolean; writeOut: (data: string) => void }
    internals.writeOut = () => {}
    internals._terminalIsSetup = true
  }

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  styles.push(syntaxStyle)
  const theme = resolveTheme(DEFAULT_THEMES.cursor, "dark")

  const data: { message: { [sessionID: string]: Message[] }; part: { [messageID: string]: Part[] } } = {
    message: { s1: [] },
    part: {},
  }

  const replay = createTranscriptReplay({
    renderer: out.renderer,
    sessionID: "s1",
    data,
    theme: () => theme,
    syntax: () => syntaxStyle,
    treeSitterClient,
    revertedFrom: () => undefined,
    debounceMs: 5,
    active: () => true,
    banner: () => {
      out.renderer.writeToScrollback(noteWriter({ text: "= session banner", theme }))
    },
  })

  return { renderer: out.renderer, external: out.externalOutput, data, replay }
}

function user(id: string): Message {
  return { id, sessionID: "s1", role: "user", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "s1", messageID, type: "text", text, time: { start: 1, end: 2 } } as Part
}

function conversation(count: number): { messages: Message[]; parts: { [id: string]: Part[] } } {
  const messages: Message[] = []
  const parts: { [id: string]: Part[] } = {}
  for (let index = 1; index <= count; index++) {
    const id = `m-${index}`
    messages.push(user(id))
    parts[id] = [textPart(`p-${index}`, id, `message ${index}`)]
  }
  return { messages, parts }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for cover transition")
}

test("repeated tall dock round-trips restore the exact output row", async () => {
  const out = await setup(true)
  try {
    // The test renderer normally leaves terminal transitions disabled. Enable
    // its native split-footer state machine while swallowing raw ANSI writes.
    const internals = out.renderer as unknown as {
      _terminalIsSetup: boolean
      writeOut: (data: string) => void
      getSplitOutputOffset: (surfaceOffset: number) => number
      getSplitPinnedRenderOffset: () => number
    }
    const { messages, parts } = conversation(12)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()
    await out.renderer.idle()
    const before = internals.getSplitOutputOffset(internals.getSplitPinnedRenderOffset())

    const controller = createCoverController({
      renderer: out.renderer,
      active: () => true,
      restore: async () => {
        out.replay.request("surface")
        await out.replay.flush()
      },
      notify: () => out.replay.notify(),
    })

    for (let attempt = 0; attempt < 3; attempt++) {
      const replayCount = out.replay.replays
      controller.apply(17, true)
      await waitFor(() => out.renderer.footerHeight === 17)
      await out.renderer.idle()
      // The transient surface owns these rows without scrolling the transcript
      // above it: the output model is rebased to the surface's top.
      expect(internals.getSplitOutputOffset(internals.getSplitPinnedRenderOffset())).toBe(13)

      controller.apply(6, false)
      await waitFor(() => out.replay.replays === replayCount + 1)
      await waitFor(() => internals.getSplitOutputOffset(internals.getSplitPinnedRenderOffset()) === before)
    }

    expect(out.renderer.footerHeight).toBe(6)
    expect(internals.getSplitOutputOffset(internals.getSplitPinnedRenderOffset())).toBe(before)
    controller.dispose()
  } finally {
    out.replay.dispose()
  }
})

test("output arriving under an overlay is included by the close replay", async () => {
  const out = await setup(true)
  try {
    const first = conversation(2)
    out.data.message.s1 = first.messages
    out.data.part = first.parts
    out.replay.notify()
    await out.replay.flush()
    out.external.take()

    const controller = createCoverController({
      renderer: out.renderer,
      active: () => true,
      restore: async () => {
        out.replay.request("surface")
        await out.replay.flush()
      },
      notify: () => out.replay.notify(),
    })

    controller.apply(17, true)
    await waitFor(() => out.renderer.footerHeight === 17)

    out.data.message.s1 = [...first.messages, user("m-3")]
    out.data.part["m-3"] = [textPart("p-3", "m-3", "message 3")]
    controller.notify()
    await Bun.sleep(30)
    expect(out.external.takeText()).not.toContain("message 3")

    controller.apply(6, false)
    await waitFor(() => out.replay.replays === 1)
    let restored = ""
    await waitFor(() => {
      restored += out.external.takeText()
      return restored.includes("message 3")
    })
    expect(restored).toContain("message 3")
    controller.dispose()
  } finally {
    out.replay.dispose()
  }
})

test("dismissing before the overlay opens does not leave commits paused", async () => {
  const out = await setup()
  try {
    let notifications = 0
    const controller = createCoverController({
      renderer: out.renderer,
      active: () => true,
      restore: async () => {},
      notify: () => notifications++,
    })

    controller.apply(17, true)
    controller.apply(6, false)
    controller.notify()

    expect(notifications).toBe(1)
    controller.dispose()
  } finally {
    out.replay.dispose()
  }
})

test("an overlay reopened during restore waits for the replay", async () => {
  const out = await setup(true)
  try {
    let release!: () => void
    const restored = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = createCoverController({
      renderer: out.renderer,
      active: () => true,
      restore: () => restored,
      notify: () => {},
    })

    controller.apply(17, true)
    await waitFor(() => out.renderer.footerHeight === 17)
    controller.apply(6, false)
    await waitFor(() => out.renderer.footerHeight === 6)

    controller.apply(17, true)
    // The replay still owns restoration; the new overlay must not race it.
    expect(out.renderer.footerHeight).toBe(6)
    release()
    await waitFor(() => out.renderer.footerHeight === 17)

    controller.dispose()
  } finally {
    out.replay.dispose()
  }
})
