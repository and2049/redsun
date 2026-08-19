import { describe, expect, it } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeSubagents } from "@opencode-ai/core/plugin/redsun/claude-code/subagents"

const msg = (input: unknown) => input as SDKMessage

const harness = (input?: { createFails?: boolean }) => {
  const created: { title: string; agent: string }[] = []
  const events: ClaudeCodeSubagents.ChildEvent[] = []
  let children = 0
  let messages = 0
  const ops: ClaudeCodeSubagents.Ops = {
    createChild: async (child) => {
      created.push(child)
      if (input?.createFails) return undefined
      children += 1
      return `ses_child_${children}`
    },
    publish: async (batch) => {
      events.push(...batch)
    },
    messageID: () => `msg_${++messages}`,
  }
  const mirror = ClaudeCodeSubagents.make({ parentSessionID: "ses_parent", ops })
  return { mirror, created, events, kinds: () => events.map((event) => event.kind) }
}

const taskStarted = (input: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: "task_1",
  tool_use_id: "toolu_1",
  description: "audit the config loader",
  subagent_type: "explore",
  ...input,
})

const taskNotification = (input: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_notification",
  task_id: "task_1",
  tool_use_id: "toolu_1",
  status: "completed",
  output_file: "",
  summary: "done",
  ...input,
})

const childAssistant = (content: unknown[], id = "api_1") => ({
  type: "assistant",
  parent_tool_use_id: "toolu_1",
  message: { id, content },
})

describe("ClaudeCodeSubagents", () => {
  it("mints one child session per subagent task", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted({ prompt: "look at config.ts" })))

    expect(h.created).toEqual([{ title: "audit the config loader (@explore subagent)", agent: "explore" }])
    expect(h.events).toEqual([
      { kind: "execution-started", sessionID: "ses_child_1" },
      { kind: "synthetic", sessionID: "ses_child_1", text: "look at config.ts" },
    ])
    expect(h.mirror.children().get("toolu_1")).toMatchObject({
      sessionID: "ses_child_1",
      parentSessionID: "ses_parent",
      description: "audit the config loader",
    })
  })

  it("ignores a repeated task_started for the same tool call", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(taskStarted()))
    expect(h.created).toHaveLength(1)
  })

  it("skips ambient tasks the CLI marks as off-transcript", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted({ skip_transcript: true })))
    expect(h.created).toHaveLength(0)
    expect(h.mirror.children().size).toBe(0)
  })

  it("skips a task with no tool_use id, which nothing could correlate", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted({ tool_use_id: undefined })))
    expect(h.created).toHaveLength(0)
  })

  it("degrades to no mirroring when the child session cannot be created", async () => {
    const h = harness({ createFails: true })
    await h.mirror.observe(msg(taskStarted()))
    expect(h.created).toHaveLength(1)
    expect(h.events).toHaveLength(0)
    expect(h.mirror.children().size).toBe(0)
  })

  it("keeps the entry after task_notification so the parent tool_result still resolves", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(taskNotification()))

    // Mark, don't delete: the CLI emits this BEFORE the main-thread tool_result
    // for a foreground task, and translate.ts looks the child up at that point.
    expect(h.mirror.children().get("toolu_1")?.sessionID).toBe("ses_child_1")
    expect(h.kinds()).toEqual(["execution-started", "execution-succeeded"])
  })

  it("resolves a notification that carries only the task id", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(taskNotification({ tool_use_id: undefined })))
    expect(h.kinds()).toEqual(["execution-started", "execution-succeeded"])
  })

  it("settles each task once", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(taskNotification()))
    await h.mirror.observe(msg(taskNotification()))
    expect(h.kinds().filter((kind) => kind === "execution-succeeded")).toHaveLength(1)
  })

  it("authors the child transcript from full subagent frames", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(
      msg(
        childAssistant([
          { type: "thinking", thinking: "checking the loader" },
          { type: "text", text: "Found it." },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/config.ts" } },
        ]),
      ),
    )

    expect(h.events.slice(1)).toEqual([
      { kind: "step-started", sessionID: "ses_child_1", messageID: "msg_1", agent: "explore" },
      { kind: "reasoning", sessionID: "ses_child_1", messageID: "msg_1", ordinal: 0, text: "checking the loader" },
      { kind: "text", sessionID: "ses_child_1", messageID: "msg_1", ordinal: 1, text: "Found it." },
      {
        kind: "tool-called",
        sessionID: "ses_child_1",
        messageID: "msg_1",
        id: "toolu_read",
        // Renamed onto v2's vocabulary so the child renders like any other session.
        name: "read",
        input: { path: "/repo/config.ts" },
      },
    ])
  })

  it("attaches a tool result to the child message that issued the call", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(childAssistant([{ type: "tool_use", id: "toolu_read", name: "Read", input: {} }])))
    await h.mirror.observe(
      msg({
        type: "user",
        parent_tool_use_id: "toolu_1",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "file body" }] },
      }),
    )

    expect(h.events.at(-1)).toEqual({
      kind: "tool-result",
      sessionID: "ses_child_1",
      messageID: "msg_1",
      id: "toolu_read",
      text: "file body",
      failed: false,
    })
  })

  it("marks an errored tool result as failed", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(childAssistant([{ type: "tool_use", id: "toolu_read", name: "Read", input: {} }])))
    await h.mirror.observe(
      msg({
        type: "user",
        parent_tool_use_id: "toolu_1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "nope", is_error: true }],
        },
      }),
    )
    expect(h.events.at(-1)).toMatchObject({ kind: "tool-result", failed: true })
  })

  it("closes the previous step before opening the next one", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "one" }], "api_1")))
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "two" }], "api_2")))

    expect(h.kinds()).toEqual([
      "execution-started",
      "step-started",
      "text",
      "step-ended",
      "step-started",
      "text",
    ])
  })

  it("mirrors a repeated api message id only once", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "one" }])))
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "one" }])))
    expect(h.kinds().filter((kind) => kind === "step-started")).toHaveLength(1)
  })

  it("ignores frames for a subagent it never minted", async () => {
    const h = harness()
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "orphan" }])))
    expect(h.events).toHaveLength(0)
  })

  it("ignores main-thread frames", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "api", content: [] } }))
    expect(h.kinds()).toEqual(["execution-started"])
  })

  it("closes an unsettled child at the turn-end sweep and clears the map", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(childAssistant([{ type: "text", text: "partial" }])))
    await h.mirror.sweep()

    expect(h.kinds()).toEqual(["execution-started", "step-started", "text", "step-ended", "execution-succeeded"])
    expect(h.mirror.children().size).toBe(0)
  })

  it("does not re-close a child that already settled", async () => {
    const h = harness()
    await h.mirror.observe(msg(taskStarted()))
    await h.mirror.observe(msg(taskNotification()))
    await h.mirror.sweep()
    expect(h.kinds().filter((kind) => kind === "execution-succeeded")).toHaveLength(1)
    expect(h.mirror.children().size).toBe(0)
  })

  it("hands translate.ts the live map rather than a snapshot", async () => {
    const h = harness()
    // language-model.ts reads children() once, before any child exists.
    const captured = h.mirror.children()
    expect(captured.size).toBe(0)
    await h.mirror.observe(msg(taskStarted()))
    expect(captured.get("toolu_1")?.sessionID).toBe("ses_child_1")
  })
})
