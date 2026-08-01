import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { deriveBlocks } from "../../src/shell/transcript/blocks"

function user(id: string): Message {
  return { id, sessionID: "s1", role: "user", time: { created: 1 } } as Message
}

function assistant(id: string, completed?: number, error?: { name: string; data: { message: string } }): Message {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    time: { created: 1, completed },
    error,
    parentID: "s1",
    modelID: "little-frank",
    providerID: "acme",
    mode: "build",
  } as Message
}

function textPart(id: string, messageID: string, text: string, end?: number): Part {
  return { id, sessionID: "s1", messageID, type: "text", text, time: { start: 1, end } } as Part
}

function toolPart(id: string, messageID: string, tool: string, state: Record<string, unknown>): Part {
  return { id, sessionID: "s1", messageID, type: "tool", callID: `c-${id}`, tool, state } as Part
}

function source(messages: Message[], parts: Record<string, Part[]>) {
  return { messages, partsOf: (messageID: string) => parts[messageID] ?? [] }
}

test("orders user, assistant text, and turn summary blocks", () => {
  const blocks = deriveBlocks(
    source([user("m-1"), assistant("m-2", 5)], {
      "m-1": [textPart("p-1", "m-1", "hello")],
      "m-2": [textPart("p-2", "m-2", "world", 4)],
    }),
  )

  expect(blocks.map((block) => block.kind)).toEqual(["user", "assistant-text", "turn-summary"])
  expect(blocks.every((block) => block.final)).toBe(true)
})

test("streaming assistant text stays non-final until the part or message settles", () => {
  const messages = [user("m-1"), assistant("m-2")]
  const parts = {
    "m-1": [textPart("p-1", "m-1", "hi")],
    "m-2": [textPart("p-2", "m-2", "partial")],
  }

  const streaming = deriveBlocks(source(messages, parts))
  expect(streaming.at(-1)).toMatchObject({ kind: "assistant-text", final: false })

  parts["m-2"] = [textPart("p-2", "m-2", "partial done", 9)]
  const settled = deriveBlocks(source(messages, parts))
  expect(settled.at(-1)).toMatchObject({ kind: "assistant-text", final: true })
})

test("queued user messages are excluded until the in-flight assistant completes", () => {
  const parts = {
    "m-1": [textPart("p-1", "m-1", "first")],
    "m-2": [textPart("p-2", "m-2", "reply")],
    "m-3": [textPart("p-3", "m-3", "queued prompt")],
  }

  const streaming = deriveBlocks(source([user("m-1"), assistant("m-2"), user("m-3")], parts))
  expect(streaming.some((block) => block.key === "m-3:user")).toBe(false)

  const completed = deriveBlocks(source([user("m-1"), assistant("m-2", 5), user("m-3")], parts))
  const keys = completed.map((block) => block.key)
  expect(keys).toEqual(["m-1:user", "p-2:text", "m-2:summary", "m-3:user"])
})

test("promotion appends after the committed prefix (prefix stability)", () => {
  const parts = {
    "m-1": [textPart("p-1", "m-1", "first")],
    "m-2": [textPart("p-2", "m-2", "reply")],
    "m-3": [textPart("p-3", "m-3", "queued prompt")],
  }

  const before = deriveBlocks(source([user("m-1"), assistant("m-2"), user("m-3")], parts))
  const after = deriveBlocks(source([user("m-1"), assistant("m-2", 5), user("m-3")], parts))
  for (let index = 0; index < before.length; index++) {
    expect(after[index]?.key).toBe(before[index]!.key)
  }
})

test("running tools block; completed and errored tools are final", () => {
  const running = deriveBlocks(
    source([assistant("m-1")], {
      "m-1": [toolPart("p-1", "m-1", "bash", { status: "running", input: {}, time: { start: 1 } })],
    }),
  )
  expect(running[0]).toMatchObject({ kind: "tool", final: false })

  const done = deriveBlocks(
    source([assistant("m-1", 5)], {
      "m-1": [
        toolPart("p-1", "m-1", "bash", {
          status: "completed",
          input: {},
          output: "ok",
          title: "ls -la",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
        toolPart("p-2", "m-1", "grep", {
          status: "error",
          input: {},
          error: "boom",
          time: { start: 1, end: 2 },
        }),
      ],
    }),
  )
  expect(done[0]).toMatchObject({ kind: "tool", final: true })
  const bash = done[0]
  if (bash?.kind !== "tool") throw new Error("expected tool block")
  expect(bash.part.state.status === "completed" && bash.part.state.title).toBe("ls -la")

  // grep is collapsible, so it derives as a (single-item) run.
  expect(done[1]).toMatchObject({ kind: "tool-run", final: true, key: "p-2:run" })
})

test("consecutive read/grep/glob calls merge into one run that closes on the next block", () => {
  const readState = (id: string) => ({
    status: "completed",
    input: { filePath: `src/${id}.ts` },
    output: "",
    title: `src/${id}.ts`,
    metadata: {},
    time: { start: 1, end: 2 },
  })

  // Open run: nothing follows it and the message is still streaming.
  const parts = {
    "m-1": [toolPart("p-1", "m-1", "read", readState("a")), toolPart("p-2", "m-1", "grep", readState("b"))],
  }
  const open = deriveBlocks(source([assistant("m-1")], parts))
  expect(open).toHaveLength(1)
  expect(open[0]).toMatchObject({ kind: "tool-run", key: "p-1:run", final: false })

  // A trailing non-collapsible part closes the run without changing its key.
  parts["m-1"] = [...parts["m-1"], textPart("p-3", "m-1", "found it")]
  const closed = deriveBlocks(source([assistant("m-1")], parts))
  expect(closed[0]).toMatchObject({ kind: "tool-run", key: "p-1:run", final: true })
  const run = closed[0]
  if (run?.kind !== "tool-run") throw new Error("expected tool-run block")
  expect(run.parts.map((part) => part.id)).toEqual(["p-1", "p-2"])

  // Message completion also closes a trailing run.
  const completed = deriveBlocks(
    source([assistant("m-2", 5)], {
      "m-2": [toolPart("p-4", "m-2", "glob", readState("c"))],
    }),
  )
  expect(completed[0]).toMatchObject({ kind: "tool-run", key: "p-4:run", final: true })
})

test("a collapsible call after a non-collapsible part starts a new run (prefix stability)", () => {
  const state = {
    status: "completed",
    input: {},
    output: "",
    title: "t",
    metadata: {},
    time: { start: 1, end: 2 },
  }
  const parts = {
    "m-1": [
      toolPart("p-1", "m-1", "read", state),
      toolPart("p-2", "m-1", "bash", state),
      toolPart("p-3", "m-1", "read", state),
    ],
  }
  const before = deriveBlocks(source([assistant("m-1")], parts))
  expect(before.map((block) => block.key)).toEqual(["p-1:run", "p-2:tool", "p-3:run"])

  // Growing the trailing run never rewrites earlier keys.
  parts["m-1"] = [...parts["m-1"], toolPart("p-4", "m-1", "grep", state)]
  const after = deriveBlocks(source([assistant("m-1")], parts))
  expect(after.map((block) => block.key)).toEqual(["p-1:run", "p-2:tool", "p-3:run"])
})

test("aborted turns record an interruption note instead of a summary", () => {
  const blocks = deriveBlocks(
    source([assistant("m-1", 5, { name: "MessageAbortedError", data: { message: "aborted" } })], {
      "m-1": [textPart("p-1", "m-1", "partial", 4)],
    }),
  )
  expect(blocks.at(-1)).toMatchObject({ kind: "note", text: "⨯ interrupted" })

  const failed = deriveBlocks(
    source([assistant("m-1", 5, { name: "UnknownError", data: { message: "provider exploded" } })], {
      "m-1": [],
    }),
  )
  expect(failed.at(-1)).toMatchObject({ kind: "error", text: "provider exploded" })
})

test("turn summaries carry the goal verdict when it has already arrived", () => {
  const verdict = { ok: true, reason: "tests pass", attempt: 1, messageID: "m-1" }
  const blocks = deriveBlocks({
    ...source([assistant("m-1", 5)], { "m-1": [textPart("p-1", "m-1", "done", 4)] }),
    goalVerdict: (messageID) => (messageID === "m-1" ? verdict : undefined),
  })
  expect(blocks.at(-1)).toMatchObject({ kind: "turn-summary", verdict: { ok: true, reason: "tests pass" } })
})

test("empty finals are skipped, not rendered", () => {
  const blocks = deriveBlocks(
    source([user("m-1"), assistant("m-2", 5)], {
      "m-1": [],
      "m-2": [textPart("p-2", "m-2", "   ", 4)],
    }),
  )
  expect(blocks.find((block) => block.key === "m-1:user")).toMatchObject({ final: true, skip: true })
  expect(blocks.find((block) => block.key === "p-2:text")).toMatchObject({ final: true, skip: true })
})

test("a revert drops the reverted messages and records how many", () => {
  const messages = [user("m-1"), assistant("m-2", 5), user("m-3")]
  const parts = {
    "m-1": [textPart("p-1", "m-1", "first")],
    "m-2": [textPart("p-2", "m-2", "reply", 4)],
    "m-3": [textPart("p-3", "m-3", "second")],
  }

  const live = deriveBlocks(source(messages, parts))
  expect(live.map((block) => block.key)).toContain("m-3:user")

  const reverted = deriveBlocks({ ...source(messages, parts), revertedFrom: "m-2" })
  expect(reverted.map((block) => block.key)).toEqual(["m-1:user", "m-2:reverted"])
  expect(reverted.at(-1)).toMatchObject({ kind: "note", final: true, text: "↩ 2 messages reverted" })
})
