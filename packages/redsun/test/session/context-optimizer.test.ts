import { describe, expect, test } from "bun:test"
import type { ModelMessage, Tool } from "ai"
import { ContextOptimizer } from "../../src/session/context-optimizer"

function result(id: string, value: string) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "bash",
        output: { type: "text", value },
      },
    ],
  } as ModelMessage
}

describe("ContextOptimizer", () => {
  test("bounds injected fragments with an explicit marker", () => {
    const value = ContextOptimizer.boundText("project memory", "x".repeat(200), 100)
    expect(value.length).toBe(100)
    expect(value).toContain("x")
    expect(value).toContain("project memory truncated")
  })

  test("preserves recent tool results and replaces older aggregate replay", () => {
    const messages = Array.from({ length: 5 }, (_, index) => result(`call_${index}`, `${index}`.repeat(100)))
    const optimized = ContextOptimizer.limitToolResultReplay(messages, 250, 2)
    const values = optimized.map((message) => JSON.stringify(message))

    expect(values.at(-1)).toContain("4".repeat(100))
    expect(values.at(-2)).toContain("3".repeat(100))
    expect(values.slice(0, 3).every((value) => value.includes("older tool result omitted"))).toBe(true)
  })

  test("reports non-overlapping context categories", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "normal<extension-context>custom</extension-context>" },
      result("call_1", "tool output"),
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,Zm9v" }] },
    ]
    const tools = { bash: { description: "run command" } as Tool }
    const value = ContextOptimizer.breakdown({ system: ["system"], messages, tools })

    expect(value.system).toBeGreaterThan(0)
    expect(value.tools).toBeGreaterThan(0)
    expect(value.messages).toBeGreaterThan(0)
    expect(value.toolResults).toBeGreaterThan(0)
    expect(value.customMessages).toBeGreaterThan(0)
    expect(value.attachments).toBeGreaterThan(0)
    expect(value.total).toBe(
      value.system + value.tools + value.messages + value.toolResults + value.customMessages + value.attachments,
    )
  })
})
