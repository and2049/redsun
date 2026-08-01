import { afterEach, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { createTranscriptReplay, type ReplayReason } from "../../src/shell/transcript/replay"
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

async function setup(options: { cap?: number; resetOnStart?: boolean } = {}) {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  styles.push(syntaxStyle)
  const theme = resolveTheme(DEFAULT_THEMES.cursor, "dark")

  const data: { message: { [sessionID: string]: Message[] }; part: { [messageID: string]: Part[] } } = {
    message: { s1: [] },
    part: {},
  }
  const state = { revert: undefined as string | undefined, banners: 0, reasons: [] as ReplayReason[] }

  const replay = createTranscriptReplay({
    renderer: out.renderer,
    sessionID: "s1",
    data,
    theme: () => theme,
    syntax: () => syntaxStyle,
    treeSitterClient,
    revertedFrom: () => state.revert,
    cap: options.cap,
    debounceMs: 5,
    active: () => true,
    resetOnStart: options.resetOnStart,
    banner: () => {
      state.banners++
      out.renderer.writeToScrollback(noteWriter({ text: "= session banner", theme }))
    },
    onReplay: (reason) => state.reasons.push(reason),
  })

  return { renderer: out.renderer, external: out.externalOutput, data, state, replay }
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

test("a revert replays the transcript without the reverted messages", async () => {
  const out = await setup()

  try {
    const { messages, parts } = conversation(3)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()

    const first = out.external.takeText()
    expect(first).toContain("message 1")
    expect(first).toContain("message 3")
    expect(out.replay.replays).toBe(0)
    expect(out.state.banners).toBe(1)

    // Reverting to m-3 drops it from the derived list, which no longer
    // matches committed output — the committer desyncs and hands over.
    out.state.revert = "m-3"
    out.replay.notify()
    await out.replay.flush()

    expect(out.replay.replays).toBe(1)
    expect(out.state.reasons).toEqual(["revert"])
    expect(out.state.banners).toBe(2)

    const replayed = out.external.takeText()
    expect(replayed).toContain("message 1")
    expect(replayed).toContain("message 2")
    expect(replayed).not.toContain("message 3")
    expect(replayed).toContain("1 message reverted")
  } finally {
    out.replay.dispose()
  }
})

test("redo replays again and restores the reverted messages", async () => {
  const out = await setup()

  try {
    const { messages, parts } = conversation(2)
    out.data.message.s1 = messages
    out.data.part = parts
    out.state.revert = "m-2"
    out.replay.notify()
    await out.replay.flush()
    expect(out.external.takeText()).not.toContain("message 2")

    out.state.revert = undefined
    out.replay.notify()
    await out.replay.flush()

    expect(out.replay.replays).toBe(1)
    const restored = out.external.takeText()
    expect(restored).toContain("message 1")
    expect(restored).toContain("message 2")
    expect(restored).not.toContain("reverted")
  } finally {
    out.replay.dispose()
  }
})

test("a burst of resizes coalesces into one replay", async () => {
  const out = await setup()

  try {
    const { messages, parts } = conversation(2)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()
    out.external.take()

    out.replay.request("resize")
    out.replay.request("resize")
    out.replay.request("resize")
    await out.replay.flush()

    expect(out.replay.replays).toBe(1)
    expect(out.state.reasons).toEqual(["resize"])
    expect(out.external.takeText()).toContain("message 2")
  } finally {
    out.replay.dispose()
  }
})

test("a capped replay keeps the newest blocks behind a truncation note", async () => {
  const out = await setup({ cap: 2 })

  try {
    const { messages, parts } = conversation(5)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()

    const committed = out.external.takeText()
    expect(committed).toContain("3 earlier blocks not replayed")
    expect(committed).not.toContain("message 1")
    expect(committed).not.toContain("message 3")
    expect(committed).toContain("message 4")
    expect(committed).toContain("message 5")

    // Blocks arriving after the initial snapshot are live output, never capped.
    out.data.message.s1 = [...messages, user("m-6")]
    out.data.part["m-6"] = [textPart("p-6", "m-6", "message 6")]
    out.replay.notify()
    await out.replay.flush()
    expect(out.external.takeText()).toContain("message 6")
  } finally {
    out.replay.dispose()
  }
})

test("switching sessions clears scrollback before the first commit", async () => {
  const out = await setup({ resetOnStart: true })

  try {
    const { messages, parts } = conversation(1)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()

    // The reset happens before the banner, so the new session's transcript is
    // all that remains; it is not counted as a replay.
    expect(out.replay.replays).toBe(0)
    expect(out.state.banners).toBe(1)
    expect(out.external.takeText()).toContain("message 1")
  } finally {
    out.replay.dispose()
  }
})

test("disposing cancels a scheduled replay", async () => {
  const out = await setup()

  try {
    const { messages, parts } = conversation(1)
    out.data.message.s1 = messages
    out.data.part = parts
    out.replay.notify()
    await out.replay.flush()

    out.replay.request("resize")
    out.replay.dispose()
    await Bun.sleep(20)

    expect(out.replay.replays).toBe(0)
  } finally {
    out.replay.dispose()
  }
})
