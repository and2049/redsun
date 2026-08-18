import { describe, expect, it } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeTranslate } from "@opencode-ai/core/plugin/redsun/claude-code/translate"

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

  it("maps Bash onto shell and flags error results", () => {
    const { parts } = run([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "ls" } }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true }] },
      },
    ])
    expect(parts[0]).toMatchObject({ toolName: "shell" })
    expect(parts[1]).toMatchObject({ toolName: "shell", result: "boom", isError: true })
  })

  it("drops subagent-attributed frames from the parent stream", () => {
    const { parts } = run([
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }, "tu_parent"),
      { type: "assistant", parent_tool_use_id: "tu_parent", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } },
      { type: "user", parent_tool_use_id: "tu_parent", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] } },
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
          message: { content: [{ type: "tool_use", id: "tu_3", name: "Agent", input: { description: "review docs" } }] },
        },
        {
          type: "user",
          tool_use_result: { status: "completed", totalToolUseCount: 4, totalDurationMs: 1200 },
          message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "done" }] },
        },
      ],
      children,
    )
    expect(parts[0]).toMatchObject({
      toolName: "subagent",
      providerMetadata: { redsun: { sessionID: "ses_child", parentSessionID: "ses_parent" } },
    })
    expect(parts[1]).toMatchObject({
      toolName: "subagent",
      result: {
        output: "done",
        title: "review docs",
        metadata: { sessionID: "ses_child", toolcalls: 4, duration: 1200 },
      },
    })
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
    expect(call[0]).toMatchObject({
      providerMetadata: { redsun: { sessionID: "ses_late", parentSessionID: "ses_parent" } },
    })

    // The parent tool_result arrives after task_notification for a foreground
    // task, so the entry must still be present here.
    const result = ClaudeCodeTranslate.translate(
      state,
      msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_late", content: "ok" }] } }),
    )
    expect(result[0]).toMatchObject({ result: { title: "late child", metadata: { sessionID: "ses_late" } } })
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
    const finish = parts.at(-1) as { usage: { inputTokens: Record<string, number>; outputTokens: Record<string, number> } }
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
    const { parts } = run([
      { type: "result", subtype: "error_during_execution", is_error: false, usage: {} },
    ])
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

  it("renders a manual compaction boundary and stays silent for an automatic one", () => {
    const manual = run([
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 120_000, post_tokens: 20_000 } },
    ])
    expect(manual.parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end"])
    expect((manual.parts[1] as { delta: string }).delta).toContain("120,000")

    const auto = run([
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 2 } },
    ])
    expect(auto.parts).toEqual([])
  })

  it("tracks the claude session id for resume", () => {
    const { state } = run([{ type: "system", subtype: "init", session_id: "cc_session_1" }])
    expect(state.claudeSessionID).toBe("cc_session_1")
  })
})
