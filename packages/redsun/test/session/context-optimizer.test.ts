import { describe, expect, test } from "bun:test"
import { ContextOptimizer } from "../../src/session/context-optimizer"
import { MessageV2 } from "../../src/session/message-v2"
import { CompactionExtractor } from "../../src/session/compaction-extractor"

describe("ContextOptimizer.boundText", () => {
  test("truncates oversized fragments with an explicit marker", () => {
    const result = ContextOptimizer.boundText("test fragment", "x".repeat(20), 8)

    expect(result).toContain("x".repeat(8))
    expect(result).toContain("[redsun: context item truncated]")
    expect(result).toContain("test fragment exceeded 8 chars")
  })
})

describe("model-visible tool output", () => {
  function toolPart(output: string): MessageV2.ToolPart {
    return {
      id: "part_tool",
      sessionID: "ses_test",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "printf lots" },
        output,
        title: "large output",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
  }

  test("keeps full output stored while adding a shorter model output", () => {
    const full = "a".repeat(ContextOptimizer.DEFAULT_TOOL_OUTPUT_MAX_CHARS + 100)
    const optimized = MessageV2.optimizePartForStorage(toolPart(full)) as MessageV2.ToolPart

    expect(optimized.state.status).toBe("completed")
    if (optimized.state.status !== "completed") throw new Error("expected completed")
    expect(optimized.state.output).toBe(full)
    expect(optimized.state.modelOutput).toContain("[redsun: tool result shortened for model context]")
    expect(optimized.state.modelOutput).toContain("part: part_tool")
    expect(optimized.state.modelOutput!.length).toBeLessThan(full.length)
  })

  test("compaction inventory uses the shortened model output reference", () => {
    const full = "a".repeat(ContextOptimizer.DEFAULT_TOOL_OUTPUT_MAX_CHARS + 100)
    const optimized = MessageV2.optimizePartForStorage(toolPart(full)) as MessageV2.ToolPart
    const state = CompactionExtractor.extract([
      {
        info: {
          id: "msg_user",
          sessionID: "ses_test",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4.1" },
        },
        parts: [{ id: "part_text", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "run it" }],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID: "ses_test",
          role: "assistant",
          time: { created: 2, completed: 3 },
          parentID: "msg_user",
          modelID: "gpt-4.1",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [optimized],
      },
    ])
    const summary = CompactionExtractor.serialize(state)

    expect(summary).toContain("[redsun: tool result shortened for model context]")
    expect(summary).not.toContain("a".repeat(1000))
  })
})

describe("ContextOptimizer.breakdown", () => {
  test("reports non-overlapping custom, attachment, and tool-result categories", () => {
    const result = ContextOptimizer.breakdown({
      system: ["stable system"],
      tools: {},
      messages: [
        { role: "user", content: [{ type: "text", text: "[custom:test] hello" }] },
        { role: "user", content: [{ type: "file", url: "data:image/png;base64,abcd", mediaType: "image/png" }] } as any,
        {
          role: "assistant" as const,
          content: [{ type: "tool-bash", state: "output-available", toolCallId: "call_1", output: "tool output" }],
        } as any,
      ],
    })

    expect(result.system).toBeGreaterThan(0)
    expect(result.customMessages).toBeGreaterThan(0)
    expect(result.attachments).toBeGreaterThan(0)
    expect(result.toolResults).toBeGreaterThan(0)
    expect(result.messages).toBe(0)
    expect(result.total).toBe(result.system + result.tools + result.messages + result.toolResults + result.customMessages + result.attachments)
  })
})

describe("ContextOptimizer.optimizeModelMessages", () => {
  test("replaces older tool results after the aggregate replay budget", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "assistant" as const,
      content: [
        {
          type: "tool-bash",
          state: "output-available",
          toolCallId: `call_${index}`,
          input: {},
          output: "x".repeat(20_000),
        },
      ],
    }))

    const result = ContextOptimizer.limitToolResultReplay(messages as any)
    const text = JSON.stringify(result)

    expect(text).toContain("[redsun: older tool result omitted from model context]")
    expect(text).toContain("call_7")
  })

  test("omits older custom messages after the aggregate budget", () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `[custom:test] ${index} ${"x".repeat(10_000)}` }],
    }))

    const result = ContextOptimizer.limitCustomMessages(messages)
    const text = JSON.stringify(result)

    expect(text).toContain("[redsun: older custom message omitted from model context]")
    expect(text).toContain("[custom:test] 3")
  })

  test("keeps the custom-message omission marker in chronological order", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "before" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: `[custom:test] 0 ${"x".repeat(10_000)}` }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "between" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: `[custom:test] 1 ${"x".repeat(10_000)}` }] },
      { role: "user" as const, content: [{ type: "text" as const, text: `[custom:test] 2 ${"x".repeat(10_000)}` }] },
      { role: "user" as const, content: [{ type: "text" as const, text: `[custom:test] 3 ${"x".repeat(10_000)}` }] },
    ]

    const result = ContextOptimizer.limitCustomMessages(messages)
    const text = result.map((message) => JSON.stringify(message)).join("\n")

    expect(text.indexOf("before")).toBeLessThan(text.indexOf("[redsun: older custom message omitted from model context]"))
    expect(text.indexOf("[redsun: older custom message omitted from model context]")).toBeLessThan(text.indexOf("between"))
  })
})
