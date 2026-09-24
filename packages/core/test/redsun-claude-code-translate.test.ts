import { describe, expect, it } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeTranslate } from "@opencode/core/plugin/redsun/claude-code/translate"

const msg = (input: unknown) => input as SDKMessage

const run = (messages: readonly unknown[], children?: ReadonlyMap<string, ClaudeCodeTranslate.TaskChild>) => {
  const state = ClaudeCodeTranslate.makeState(children)
  const parts = messages.flatMap((message) => ClaudeCodeTranslate.translate(state, msg(message)))
  return { state, parts }
}

const streamEvent = (event: unknown, parentToolUseID?: string) => ({
  type: "stream_event",
  event,
  ...(parentToolUseID ? { parent_tool_use_id: parentToolUseID } : {}),
})

const result = (input: Record<string, unknown>) => ({ type: "result", subtype: "success", ...input })

describe("ClaudeCodeTranslate", () => {
  it("streams text blocks as text parts", () => {
    const { parts } = run([
      streamEvent({ type: "message_start", message: { id: "msg_1" } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ])
    expect(parts).toEqual([
      { type: "text-start", id: "msg_1:0" },
      { type: "text-delta", id: "msg_1:0", delta: "hello " },
      { type: "text-delta", id: "msg_1:0", delta: "world" },
      { type: "text-end", id: "msg_1:0" },
    ])
  })

  it("streams thinking blocks as reasoning parts", () => {
    const { parts } = run([
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ])
    expect(parts.map((part) => part.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"])
  })

  it("emits provider-executed tool calls and results with v2 tool names", () => {
    const { parts } = run([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts", limit: 10 } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }] },
      },
    ])
    expect(parts[0]).toEqual({
      type: "tool-call",
      toolCallId: "tu_1",
      toolName: "read",
      input: JSON.stringify({ path: "/a.ts", limit: 10 }),
      providerExecuted: true,
    })
    expect(parts[1]).toEqual({
      type: "tool-result",
      toolCallId: "tu_1",
      toolName: "read",
      result: "file body",
    })
  })

  it("suppresses partial-stream frames that arrive after the aggregate tool call", () => {
    // The CLI can deliver the full assistant message before the stream's
    // content_block_stop for the same block; a trailing tool-input-end would
    // kill the runner ("Duplicate tool input end").
    const { parts } = run([
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "Grep" },
      }),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "x" } }] },
      },
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"pat' },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ])
    expect(parts.map((part) => part.type)).toEqual(["tool-input-start", "tool-call"])
  })

  it("suppresses a stream block that opens after its aggregate tool call", () => {
    const { parts } = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "x" } }] },
      },
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "Grep" },
      }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ])
    expect(parts.map((part) => part.type)).toEqual(["tool-call"])
  })

  it("keeps the normal partial-stream order intact", () => {
    const { parts } = run([
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "Grep" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"pattern":"x"}' },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "x" } }] },
      },
    ])
    expect(parts.map((part) => part.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ])
  })

  it("maps Bash onto shell and flags error results", () => {
    const { parts } = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "ls" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true }] },
      },
    ])
    expect(parts[0]).toMatchObject({ toolName: "shell" })
    expect(parts[1]).toMatchObject({ toolName: "shell", result: "boom", isError: true })
  })

  it("renders host MCP calls once with original arguments and only correlated metadata", () => {
    const state = ClaudeCodeTranslate.makeState(undefined, (id) =>
      id === "tu_host" ? { todos: [{ content: "done" }] } : undefined,
    )
    const call = (id: string, name: string) =>
      ClaudeCodeTranslate.translate(
        state,
        msg({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name, input: { skill: "example" } }] },
        }),
      )
    for (const [name, expected] of [
      ["subagent", "subagent"],
      ["skill", "skill"],
      ["todowrite", "todowrite"],
      ["worker_model", "worker_model"],
    ]) {
      const id = name === "todowrite" ? "tu_host" : `tu_${name}`
      expect(call(id, `mcp__redsun__${name}`)).toEqual([
        {
          type: "tool-call",
          toolCallId: id,
          toolName: expected,
          input: '{"skill":"example"}',
          providerExecuted: true,
        },
      ])
      const parts = ClaudeCodeTranslate.translate(
        state,
        msg({
          type: "user",
          tool_use_result: { _meta: { "redsun/metadata": { untrusted: true } } },
          message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
        }),
      )
      expect(parts[0]).toMatchObject({
        toolName: expected,
        result: id === "tu_host" ? { output: "ok", metadata: { todos: [{ content: "done" }] } } : "ok",
      })
    }
    expect(call("tu_native", "Skill")[0]).toMatchObject({ toolName: "skill", input: '{"id":"example"}' })
  })

  it("uses canonical direct MCP names for stream starts, aggregate calls and results only when selected", () => {
    const selected = new Set(["mcp__redsun__my_server_ping"])
    const state = ClaudeCodeTranslate.makeState(undefined, undefined, (name) => selected.has(name))
    const events = [
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_direct", name: "mcp__redsun__my_server_ping" },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_direct", name: "mcp__redsun__my_server_ping", input: { text: "hello" } },
            { type: "tool_use", id: "tu_other", name: "mcp__redsun__other_ping", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_direct", content: "pong" },
            { type: "tool_result", tool_use_id: "tu_other", content: "other" },
          ],
        },
      },
    ]
    const parts = events.flatMap((event) => ClaudeCodeTranslate.translate(state, msg(event)))
    expect(parts.filter((part) => "toolName" in part).map((part) => part.toolName)).toEqual([
      "my_server_ping",
      "my_server_ping",
      "mcp__redsun__other_ping",
      "my_server_ping",
      "mcp__redsun__other_ping",
    ])
    expect(parts.find((part) => part.type === "tool-call" && part.toolCallId === "tu_direct")).toMatchObject({
      input: '{"text":"hello"}',
      providerExecuted: true,
    })
  })

  it("drops subagent-attributed frames from the parent stream", () => {
    const { parts } = run([
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }, "tu_parent"),
      {
        type: "assistant",
        parent_tool_use_id: "tu_parent",
        message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] },
      },
      {
        type: "user",
        parent_tool_use_id: "tu_parent",
        message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] },
      },
    ])
    expect(parts).toEqual([])
  })

  it("names the subagent tool and carries the mirrored child session", () => {
    const children = new Map([
      ["tu_3", { sessionID: "ses_child", parentSessionID: "ses_parent", description: "review docs" }],
    ])
    const { parts } = run(
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "tu_3", name: "Agent", input: { description: "review docs" } }],
          },
        },
        {
          type: "user",
          tool_use_result: { status: "completed", totalToolUseCount: 4, totalDurationMs: 1200 },
          message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "done" }] },
        },
      ],
      children,
    )
    expect(parts[0]).toMatchObject({ toolName: "subagent" })
    // The link rides the result, not the call: `providerMetadata` lands in the
    // part's `providerState`, and the renderers read `state.metadata`.
    expect(parts[0]).not.toHaveProperty("providerMetadata")
    expect(parts[1]).toMatchObject({
      toolName: "subagent",
      result: {
        output: "done",
        metadata: { sessionID: "ses_child", parentSessionID: "ses_parent", toolcalls: 4, duration: 1200 },
      },
    })
  })

  it("carries an edit's re-derived diff onto the completed part", () => {
    const { parts } = run([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_edit",
              name: "Edit",
              input: { file_path: "/a.ts", old_string: "one", new_string: "two" },
            },
          ],
        },
      },
      {
        type: "user",
        tool_use_result: {
          filePath: "/a.ts",
          oldString: "one",
          newString: "two",
          originalFile: "one\n",
          replaceAll: false,
        },
        message: { content: [{ type: "tool_result", tool_use_id: "tu_edit", content: "Applied 1 edit" }] },
      },
    ])
    expect(parts[0]).toMatchObject({
      toolName: "edit",
      input: JSON.stringify({ path: "/a.ts", oldString: "one", newString: "two" }),
    })
    expect(parts[1]).toMatchObject({
      toolName: "edit",
      result: { output: "Applied 1 edit", metadata: { files: [{ file: "/a.ts", status: "modified" }] } },
    })
  })

  it("renders a delegated AskUserQuestion as a question row with its answers", () => {
    const questions = [{ question: "Which database?", header: "Database", options: [{ label: "Postgres" }] }]
    const { parts } = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions } }] },
      },
      {
        type: "user",
        tool_use_result: { questions, answers: { "Which database?": "Postgres" } },
        message: { content: [{ type: "tool_result", tool_use_id: "tu_q", content: "User answered" }] },
      },
    ])
    expect(parts[0]).toMatchObject({ toolName: "question", input: JSON.stringify({ questions }) })
    expect(parts[1]).toMatchObject({
      toolName: "question",
      result: { output: "User answered", metadata: { answers: [["Postgres"]] } },
    })
  })

  it("leaves a plain result plain, and never attaches a diff to a failed edit", () => {
    const editCall = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_e",
            name: "Edit",
            input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
          },
        ],
      },
    }
    const failed = run([
      editCall,
      {
        type: "user",
        tool_use_result: { filePath: "/a.ts", oldString: "x", newString: "y", originalFile: "x\n" },
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_e", content: "String not found", is_error: true }],
        },
      },
    ])
    expect(failed.parts[1]).toMatchObject({ result: "String not found", isError: true })

    const read = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_r", name: "Read", input: { file_path: "/a.ts" } }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_r", content: "1|one" }] } },
    ])
    expect(read.parts[1]).toMatchObject({ toolName: "read", result: "1|one" })
  })

  it("reads the mirror's live map, which fills in after the state is made", () => {
    // language-model.ts calls hooks.taskChildren() once and hands the reference
    // to makeState before any child exists, so the mirror must hand back its
    // live map. A snapshot here would always be empty and the child link lost.
    const children = new Map<string, ClaudeCodeTranslate.TaskChild>()
    const state = ClaudeCodeTranslate.makeState(children)

    children.set("tu_late", { sessionID: "ses_late", parentSessionID: "ses_parent", description: "late child" })

    const call = ClaudeCodeTranslate.translate(
      state,
      msg({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_late", name: "Agent", input: {} }] },
      }),
    )
    expect(call[0]).toMatchObject({ toolName: "subagent", toolCallId: "tu_late" })

    // The parent tool_result arrives after task_notification for a foreground
    // task, so the entry must still be present here.
    const result = ClaudeCodeTranslate.translate(
      state,
      msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_late", content: "ok" }] } }),
    )
    expect(result[0]).toMatchObject({ result: { output: "ok", metadata: { sessionID: "ses_late" } } })
  })

  it("takes usage from the last main-thread call, not the cumulative result total", () => {
    const { parts } = run([
      {
        type: "assistant",
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 5 } },
      },
      streamEvent({ type: "message_delta", usage: { output_tokens: 120 } }),
      // result.usage sums every API call in the turn and must not be used for the input side.
      result({ usage: { input_tokens: 999_999, cache_read_input_tokens: 9_999_999, output_tokens: 700 } }),
    ])
    const finish = parts.at(-1) as {
      usage: { inputTokens: Record<string, number>; outputTokens: Record<string, number> }
    }
    expect(finish.usage.inputTokens).toEqual({ total: 4015, noCache: 10, cacheRead: 4000, cacheWrite: 5 })
    expect(finish.usage.outputTokens.total).toBe(120)
  })

  it("falls back to the result totals when no assistant frame carried usage", () => {
    const { parts } = run([result({ usage: { input_tokens: 7, output_tokens: 3 } })])
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } },
    })
  })

  it("finishes normally for an interrupt-shaped error result", () => {
    const { parts } = run([{ type: "result", subtype: "error_during_execution", is_error: false, usage: {} }])
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
  })

  it("never surfaces an ede_diagnostic as the user-facing error", () => {
    const { parts } = run([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] internal noise", "the real failure"],
        usage: {},
      },
    ])
    expect(parts).toEqual([{ type: "error", error: new Error("the real failure") }])
  })

  it("reports a turn-limit stop with its own message", () => {
    const { parts } = run([{ type: "result", subtype: "error_max_turns", is_error: true, usage: {} }])
    expect(parts[0]).toMatchObject({ type: "error" })
    expect(String((parts[0] as { error: Error }).error.message)).toContain("turn limit")
  })

  it("shows native compaction status and both boundary triggers exactly once, excluding child boundaries", () => {
    const boundary = (uuid: string, trigger: string) => ({
      type: "system",
      subtype: "compact_boundary",
      uuid,
      compact_metadata: { trigger, pre_tokens: 120_000, post_tokens: 20_000 },
    })
    const { parts } = run([
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "status", status: "compacting" },
      boundary("first", "manual"),
      boundary("first", "manual"),
      { ...boundary("child", "auto"), parent_tool_use_id: "tu_child" },
      { type: "system", subtype: "status", status: "compacting" },
      boundary("second", "auto"),
      boundary("second", "auto"),
    ])
    expect(parts.map((part) => part.type)).toEqual(
      Array(3).fill(["text-start", "text-delta", "text-end"]).flat().concat(["text-start", "text-delta", "text-end"]),
    )
    const deltas = parts.filter((part) => part.type === "text-delta").map((part) => part.delta)
    expect(deltas).toEqual([
      "Claude Code is compacting its native session history…",
      "Claude Code compacted its native session history (manual) (120,000 to 20,000 conversation tokens).",
      "Claude Code is compacting its native session history…",
      "Claude Code compacted its native session history (auto) (120,000 to 20,000 conversation tokens).",
    ])
  })

  it("tracks the claude session id for resume", () => {
    const { state } = run([{ type: "system", subtype: "init", session_id: "cc_session_1" }])
    expect(state.claudeSessionID).toBe("cc_session_1")
  })
})
