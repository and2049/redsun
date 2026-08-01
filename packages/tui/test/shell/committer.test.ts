import { afterEach, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { createTranscriptCommitter } from "../../src/shell/transcript/committer"
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

async function setup() {
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

  const data: { message: { [sessionID: string]: Message[] }; part: { [messageID: string]: Part[] } } = {
    message: { s1: [] },
    part: {},
  }

  const committer = createTranscriptCommitter({
    renderer: out.renderer,
    sessionID: "s1",
    data,
    theme: () => resolveTheme(DEFAULT_THEMES.cursor, "dark"),
    syntax: () => syntaxStyle,
    treeSitterClient,
  })

  return { renderer: out.renderer, external: out.externalOutput, data, committer }
}

function user(id: string): Message {
  return { id, sessionID: "s1", role: "user", time: { created: 1 } } as Message
}

function assistant(id: string, completed?: number): Message {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    time: { created: 1000, completed },
    parentID: "s1",
    modelID: "little-frank",
    providerID: "acme",
    mode: "build",
  } as Message
}

function textPart(id: string, messageID: string, text: string, end?: number): Part {
  return { id, sessionID: "s1", messageID, type: "text", text, time: { start: 1, end } } as Part
}

test("commits user, streamed assistant text, and turn summary in order", async () => {
  const out = await setup()

  try {
    out.data.message.s1 = [user("m-1")]
    out.data.part["m-1"] = [textPart("p-1", "m-1", "fix the tests")]
    out.committer.notify()
    await out.committer.idle()

    expect(out.external.takeText()).toContain("❯ fix the tests")

    // Assistant starts streaming — nothing final yet, but stable markdown
    // paragraphs commit progressively.
    out.data.message.s1 = [user("m-1"), assistant("m-2")]
    out.data.part["m-2"] = [textPart("p-2", "m-2", "First paragraph.\n\nSecond paragraph still growing")]
    out.committer.notify()
    await out.committer.idle()

    const streamed = out.external.takeText()
    expect(streamed).toContain("First paragraph.")
    expect(streamed).not.toContain("Second paragraph")

    // The part settles and the message completes: remainder + summary commit.
    out.data.part["m-2"] = [textPart("p-2", "m-2", "First paragraph.\n\nSecond paragraph still growing", 9)]
    out.data.message.s1 = [user("m-1"), assistant("m-2", 3200)]
    out.committer.notify()
    await out.committer.idle()

    const final = out.external.takeText()
    expect(final).toContain("Second paragraph still growing")
    expect(final).toContain("▣ Build · acme/little-frank · 2.2s")
  } finally {
    out.committer.dispose()
  }
})

test("a running tool blocks later blocks until it settles", async () => {
  const out = await setup()

  try {
    // Tool still running: everything behind it (even final text) is held.
    out.data.message.s1 = [assistant("m-1")]
    out.data.part["m-1"] = [
      {
        id: "p-1",
        sessionID: "s1",
        messageID: "m-1",
        type: "tool",
        callID: "c-1",
        tool: "bash",
        state: { status: "running", input: {}, time: { start: 1 } },
      } as Part,
      textPart("p-2", "m-1", "done!", 5),
    ]
    out.committer.notify()
    await out.committer.idle()

    expect(out.external.takeText()).toBe("")

    // Tool completes: its record commits first, then the held text.
    out.data.part["m-1"] = [
      {
        id: "p-1",
        sessionID: "s1",
        messageID: "m-1",
        type: "tool",
        callID: "c-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls -la" },
          output: "ok",
          title: "ls -la",
          metadata: { output: "ok" },
          time: { start: 1, end: 2 },
        },
      } as Part,
      textPart("p-2", "m-1", "done!", 5),
    ]
    out.committer.notify()
    await out.committer.idle()

    const output = out.external.takeText()
    expect(output).toContain("⏺ Bash(ls -la)")
    expect(output).toContain("done!")
    expect(output.indexOf("⏺ Bash")).toBeLessThan(output.indexOf("done!"))
  } finally {
    out.committer.dispose()
  }
})

test("freezes on prefix mismatch instead of corrupting scrollback", async () => {
  const out = await setup()

  try {
    out.data.message.s1 = [user("m-1"), user("m-2")]
    out.data.part["m-1"] = [textPart("p-1", "m-1", "first")]
    out.data.part["m-2"] = [textPart("p-2", "m-2", "second")]
    out.committer.notify()
    await out.committer.idle()
    expect(out.external.takeText()).toContain("first")

    // Simulate a revert removing the first message.
    out.data.message.s1 = [user("m-2")]
    out.committer.notify()
    await out.committer.idle()

    expect(out.committer.desynced).toBe(true)
    expect(out.external.takeText()).toBe("")
  } finally {
    out.committer.dispose()
  }
})
