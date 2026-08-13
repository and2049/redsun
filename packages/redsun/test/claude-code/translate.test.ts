import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TaskChild } from "@/claude-code/subagents"
import { ClaudeCodeTranslate } from "@/claude-code/translate"

const sid = "11111111-1111-4111-8111-111111111111"

function stream(event: Record<string, unknown>, parent: string | null = null): SDKMessage {
  return { type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: sid } as never
}

function run(messages: SDKMessage[], taskChildren?: ReadonlyMap<string, TaskChild>) {
  const state = ClaudeCodeTranslate.makeState(taskChildren)
  return { state, events: messages.flatMap((message) => ClaudeCodeTranslate.translate(state, message)) }
}

describe("claude-code translate", () => {
  test("text deltas become text events", () => {
    const { events } = run([
      stream({ type: "message_start", message: { id: "msg_1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      stream({ type: "content_block_stop", index: 0 }),
    ])
    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-delta", "text-end"])
    expect(events[1]).toMatchObject({ id: "msg_1:0", text: "hello" })
  })

  test("thinking deltas become reasoning events", () => {
    const { events } = run([
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      stream({ type: "content_block_stop", index: 0 }),
    ])
    expect(events.map((event) => event.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"])
  })

  test("tool use streams input and completes as provider-executed call and result", () => {
    const { events } = run([
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "Bash" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
      stream({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: sid,
      } as never,
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }] },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: sid,
      } as never,
    ])
    expect(events.map((event) => event.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "tool-result",
    ])
    expect(events[3]).toMatchObject({ id: "tu_1", name: "Bash", input: { command: "ls" }, providerExecuted: true })
    expect(events[4]).toMatchObject({
      id: "tu_1",
      name: "Bash",
      providerExecuted: true,
      result: { type: "text", value: "file.txt" },
    })
  })

  test("error tool results map to error result values", () => {
    const { events } = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_2", name: "Edit", input: {} }] },
        parent_tool_use_id: null,
        uuid: "u",
        session_id: sid,
      } as never,
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "denied" }],
        },
        parent_tool_use_id: null,
        uuid: "u",
        session_id: sid,
      } as never,
    ])
    expect(events[1]).toMatchObject({ result: { type: "error", value: "denied" } })
  })

  test("subagent-attributed frames are dropped", () => {
    const { events } = run([
      stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }, "parent_tool"),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, "parent_tool"),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_3", name: "Read", input: {} }] },
        parent_tool_use_id: "parent_tool",
        uuid: "u",
        session_id: sid,
      } as never,
    ])
    expect(events).toEqual([])
  })

  test("claude code's Task tool surfaces as redsun's task tool", () => {
    const { events } = run([
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_t", name: "Task" } }),
      stream({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_t", name: "Task", input: { description: "Find code" } }] },
        parent_tool_use_id: null,
        uuid: "u",
        session_id: sid,
      } as never,
    ])
    expect(events.map((event) => event.type)).toEqual(["tool-input-start", "tool-input-end", "tool-call"])
    expect(events[0]).toMatchObject({ name: "task" })
    expect(events[2]).toMatchObject({ name: "task", input: { description: "Find code" } })
  })

  test("a mirrored Task call and result carry the child session link", () => {
    const child: TaskChild = {
      sessionID: "ses_child" as never,
      parentSessionID: "ses_parent" as never,
      description: "Find code",
    }
    const { events } = run(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_t", name: "Task", input: { description: "Find code", prompt: "look" } },
            ],
          },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: sid,
        } as never,
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_t", content: "report" }] },
          parent_tool_use_id: null,
          tool_use_result: { status: "completed", totalToolUseCount: 7, totalDurationMs: 1234 },
          uuid: "u",
          session_id: sid,
        } as never,
      ],
      new Map([["tu_t", child]]),
    )
    expect(events[0]).toMatchObject({
      type: "tool-call",
      name: "task",
      providerMetadata: { redsun: { sessionId: "ses_child", parentSessionId: "ses_parent" } },
    })
    expect(events[1]).toMatchObject({
      type: "tool-result",
      name: "task",
      result: {
        type: "json",
        value: {
          output: "report",
          title: "Find code",
          metadata: { sessionId: "ses_child", parentSessionId: "ses_parent", toolcalls: 7, duration: 1234 },
        },
      },
    })
  })

  test("an unmapped Task call falls back to plain events", () => {
    const { events } = run([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_t", name: "Task", input: {} }] },
        parent_tool_use_id: null,
        uuid: "u",
        session_id: sid,
      } as never,
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_t", content: "report" }] },
        parent_tool_use_id: null,
        uuid: "u",
        session_id: sid,
      } as never,
    ])
    expect(events[0]).toMatchObject({ type: "tool-call", name: "task" })
    expect((events[0] as { providerMetadata?: unknown }).providerMetadata).toBeUndefined()
    expect(events[1]).toMatchObject({ type: "tool-result", result: { type: "text", value: "report" } })
  })

  test("success result emits step-finish and finish with inclusive usage", () => {
    const { state, events } = run([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        },
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    expect(events.map((event) => event.type)).toEqual(["step-finish", "finish"])
    const finish = events[1] as { usage?: Record<string, number> }
    expect(finish.usage).toMatchObject({
      inputTokens: 115,
      outputTokens: 20,
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 5,
    })
    expect(state.claudeSessionID).toBe(sid)
  })

  test("turn usage reflects the last API call, not the result's cumulative sum", () => {
    const assistant = (usage: Record<string, number>, parent: string | null = null): SDKMessage =>
      ({
        type: "assistant",
        message: { content: [], usage },
        parent_tool_use_id: parent,
        uuid: "u",
        session_id: sid,
      }) as never
    const { events } = run([
      assistant({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 22_000 }),
      assistant({ input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 22_000, cache_creation_input_tokens: 300 }),
      // A subagent frame after the last main-thread call must not win.
      assistant({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 900_000 }, "parent_tool"),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        // The SDK sums usage across both calls; only output_tokens is trusted.
        usage: { input_tokens: 18, output_tokens: 240, cache_read_input_tokens: 22_000, cache_creation_input_tokens: 22_300 },
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    const finish = events.at(-1) as { usage?: Record<string, number> }
    expect(finish.usage).toMatchObject({
      inputTokens: 8 + 22_000 + 300,
      outputTokens: 240,
      cacheReadInputTokens: 22_000,
      cacheWriteInputTokens: 300,
    })
  })

  test("manual compact boundary renders as a text notice", () => {
    const { events } = run([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 22_605, post_tokens: 1_531 },
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end"])
    const delta = events[1] as { text: string }
    expect(delta.text).toContain("22,605")
    expect(delta.text).toContain("1,531")
  })

  test("auto compact boundary stays silent", () => {
    const { events } = run([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 2_000 },
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    expect(events).toEqual([])
  })

  test("interrupted result finishes without a provider error", () => {
    const { events } = run([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    expect(events.map((event) => event.type)).toEqual(["step-finish", "finish"])
  })

  test("error result emits an actionable provider error and hides internal diagnostics", () => {
    const { events } = run([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] internal frame", "Not logged in"],
        usage: {},
        session_id: sid,
        uuid: "u",
      } as never,
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "provider-error", message: "Not logged in", retryable: false })
  })
})
