import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ClaudeCodeSubagents, type TurnInfo } from "@/claude-code/subagents"

function harness() {
  const created: Record<string, any>[] = []
  const messages: Record<string, any>[] = []
  const parts: Record<string, any>[] = []
  const statuses: { sessionID: string; status: { type: string } }[] = []
  let next = 0
  const mirror = ClaudeCodeSubagents.make({
    createSession: (input) =>
      Effect.sync(() => {
        created.push(input)
        next += 1
        return { id: `ses_child_${next}` as never }
      }),
    updateMessage: (msg) =>
      Effect.sync(() => {
        messages.push(structuredClone(msg))
        return msg
      }),
    updatePart: (part) =>
      Effect.sync(() => {
        parts.push(structuredClone(part))
        return part
      }),
    setStatus: (sessionID, status) => Effect.sync(() => void statuses.push({ sessionID, status })),
  })
  const turn: TurnInfo = {
    sessionID: "ses_parent" as never,
    model: { providerID: "claude-code" as never, modelID: "fable" as never },
    path: { cwd: "/repo", root: "/repo" },
  }
  const on = (message: Record<string, unknown>) => Effect.runSync(mirror.onMessage(turn, message as never))
  const sweep = () => Effect.runSync(mirror.turnEnded(turn.sessionID))
  return { mirror, created, messages, parts, statuses, on, sweep }
}

const taskCall = (input: Record<string, unknown> = { description: "Scan", prompt: "go", subagent_type: "explorer" }) => ({
  type: "assistant",
  message: { id: "msg_main", content: [{ type: "tool_use", id: "task_1", name: "Task", input }] },
  parent_tool_use_id: null,
})

const subAssistant = (id = "sub_m1") => ({
  type: "assistant",
  message: {
    id,
    content: [
      { type: "text", text: "working on it" },
      { type: "thinking", thinking: "quietly" },
      { type: "tool_use", id: "sub_t1", name: "Read", input: { file_path: "a.ts" } },
    ],
  },
  parent_tool_use_id: "task_1",
})

const subToolResult = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "sub_t1", content: "file contents" }] },
  parent_tool_use_id: "task_1",
}

const mainResult = (extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "task_1", content: "final report" }] },
  parent_tool_use_id: null,
  ...extra,
})

describe("claude-code subagent mirror", () => {
  test("a Task tool_use mints a child session seeded with the prompt", () => {
    const h = harness()
    h.on(taskCall())
    expect(h.created).toEqual([
      { parentID: "ses_parent", title: "Scan (@explorer subagent)", agent: "explorer" },
    ])
    expect(h.messages[0]).toMatchObject({ role: "user", sessionID: "ses_child_1", agent: "explorer" })
    expect(h.parts[0]).toMatchObject({ type: "text", text: "go", sessionID: "ses_child_1" })
    expect(h.statuses).toEqual([{ sessionID: "ses_child_1", status: { type: "busy" } }])
    expect(h.mirror.children.get("task_1")).toMatchObject({
      sessionID: "ses_child_1",
      parentSessionID: "ses_parent",
      description: "Scan",
    })
  })

  test("subagent frames mirror into the child transcript", () => {
    const h = harness()
    h.on(taskCall())
    h.on(subAssistant())
    h.on(subToolResult)
    const assistant = h.messages.find((msg) => msg.role === "assistant")
    expect(assistant).toMatchObject({ sessionID: "ses_child_1", agent: "explorer", providerID: "claude-code" })
    expect(assistant!.parentID).toBe(h.messages[0]!.id)
    // Four part writes: text, reasoning, the running tool, then its completion.
    const childParts = h.parts.filter((part) => part.messageID === assistant!.id)
    expect(childParts.map((part) => part.type)).toEqual(["text", "reasoning", "tool", "tool"])
    expect(childParts[0]).toMatchObject({ text: "working on it" })
    expect(childParts[2]).toMatchObject({ callID: "sub_t1", tool: "Read", state: { status: "running" } })
    const completed = h.parts.at(-1)!
    expect(completed).toMatchObject({
      callID: "sub_t1",
      state: { status: "completed", output: "file contents", title: "Read" },
    })
  })

  test("repeated frames sharing a claude message id don't duplicate parts", () => {
    const h = harness()
    h.on(taskCall())
    h.on(subAssistant())
    h.on(subAssistant())
    const textParts = h.parts.filter((part) => part.type === "text" && part.text === "working on it")
    expect(textParts).toHaveLength(1)
    const assistants = new Set(h.messages.filter((msg) => msg.role === "assistant").map((msg) => msg.id))
    expect(assistants.size).toBe(1)
  })

  test("frames for unknown parent ids are ignored", () => {
    const h = harness()
    h.on(taskCall())
    const before = h.parts.length
    h.on({ ...subAssistant(), parent_tool_use_id: "task_unknown" })
    expect(h.parts.length).toBe(before)
  })

  test("the main-thread Task result finalizes the child", () => {
    const h = harness()
    h.on(taskCall())
    h.on(subAssistant())
    h.on(mainResult())
    const errored = h.parts.at(-1)!
    expect(errored).toMatchObject({ callID: "sub_t1", state: { status: "error", error: "Task ended" } })
    expect(h.statuses.at(-1)).toEqual({ sessionID: "ses_child_1", status: { type: "idle" } })
    // The map entry survives until the turn-end sweep so translate can still
    // annotate the tool_result it is about to process.
    expect(h.mirror.children.has("task_1")).toBe(true)
    h.sweep()
    expect(h.mirror.children.has("task_1")).toBe(false)
  })

  test("async_launched marks the task background and keeps mirroring", () => {
    const h = harness()
    h.on(taskCall())
    h.on(mainResult({ tool_use_result: { status: "async_launched", agentId: "a1" } }))
    expect(h.mirror.children.get("task_1")).toMatchObject({ background: true })
    expect(h.statuses.some((entry) => entry.status.type === "idle")).toBe(false)
    h.sweep()
    expect(h.mirror.children.has("task_1")).toBe(true)
    h.on(subAssistant("sub_m2"))
    const assistants = new Set(h.messages.filter((msg) => msg.role === "assistant").map((msg) => msg.id))
    expect(assistants.size).toBe(1)
  })

  test("a failed task_notification errors dangling work and settles the child", () => {
    const h = harness()
    h.on(taskCall())
    h.on(mainResult({ tool_use_result: { status: "async_launched" } }))
    h.on(subAssistant())
    h.on({ type: "system", subtype: "task_notification", tool_use_id: "task_1", status: "failed", summary: "boom" })
    const errored = h.parts.at(-1)!
    expect(errored).toMatchObject({ callID: "sub_t1", state: { status: "error", error: "boom" } })
    expect(h.statuses.at(-1)).toEqual({ sessionID: "ses_child_1", status: { type: "idle" } })
    expect(h.mirror.children.has("task_1")).toBe(false)
  })

  test("an aborted turn sweeps unfinished foreground tasks", () => {
    const h = harness()
    h.on(taskCall())
    h.on(subAssistant())
    h.sweep()
    const errored = h.parts.at(-1)!
    expect(errored).toMatchObject({ callID: "sub_t1", state: { status: "error", error: "Task interrupted" } })
    expect(h.statuses.at(-1)).toEqual({ sessionID: "ses_child_1", status: { type: "idle" } })
    expect(h.mirror.children.has("task_1")).toBe(false)
  })
})
