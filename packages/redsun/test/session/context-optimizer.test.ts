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

  test("optimizeModelMessages is a no-op on an already-optimized transcript", () => {
    const messages = Array.from({ length: 3 }, (_, index) => result(`call_${index}`, `${index}`.repeat(50)))
    const first = ContextOptimizer.optimizeModelMessages(messages)
    // Request prep prepends system messages into a new array; the memo keys on
    // the message objects, so the second pass must return its input unchanged.
    const withSystem = [{ role: "system", content: "sys" } as ModelMessage, ...first]
    const second = ContextOptimizer.optimizeModelMessages(withSystem)
    expect(second).toBe(withSystem)
  })

  describe("boundInstruction", () => {
    test("returns header plus full content when under the cap", () => {
      const value = ContextOptimizer.boundInstruction("C:\\proj\\AGENTS.md", "line one\nline two", 10_000)
      expect(value).toBe("Instructions from: C:\\proj\\AGENTS.md\nline one\nline two")
    })

    test("cuts at a line boundary with a marker naming the path and read offset", () => {
      const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
      const value = ContextOptimizer.boundInstruction("C:\\proj\\memory.md", text, 400)
      expect(value.length).toBeLessThanOrEqual(400)
      expect(value).toContain("Instructions from: C:\\proj\\memory.md")
      const match = value.match(/\[redsun: instructions truncated at line (\d+) of 100 \(400 char limit\)\. Read the remainder with the read tool: C:\\proj\\memory\.md offset=(\d+)\.\]/)
      expect(match).not.toBeNull()
      const line = Number(match![1])
      expect(Number(match![2])).toBe(line + 1)
      // the kept body ends exactly at the reported line
      const body = value.slice(value.indexOf("\n") + 1, value.lastIndexOf("\n[redsun:"))
      expect(body.split("\n").at(-1)).toBe(`line ${line}`)
    })

    test("uses a URL marker without a read offset for remote instructions", () => {
      const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
      const value = ContextOptimizer.boundInstruction("https://example.com/rules.md", text, 300)
      expect(value).toContain("Full content: https://example.com/rules.md")
      expect(value).not.toContain("offset=")
    })

    test("falls back to boundText when the cap cannot fit header and marker", () => {
      const value = ContextOptimizer.boundInstruction("C:\\p\\x.md", "y".repeat(500), 60)
      expect(value.length).toBeLessThanOrEqual(60)
    })

    test("handles content without newlines", () => {
      const value = ContextOptimizer.boundInstruction("C:\\p\\one-line.md", "z".repeat(5_000), 1_000)
      expect(value.length).toBeLessThanOrEqual(1_000)
      expect(value).toContain("[redsun: instructions truncated at line 1 of 1")
    })
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
