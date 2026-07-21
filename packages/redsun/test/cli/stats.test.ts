import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { displayStats } from "../../src/cli/cmd/stats"

afterEach(() => {
  ;(console.log as { mockRestore?: () => void }).mockRestore?.()
})

describe("stats context output", () => {
  test("shows measured categories and billable cache usage", () => {
    const lines: string[] = []
    spyOn(console, "log").mockImplementation((value = "") => lines.push(String(value)))

    displayStats({
      totalSessions: 1,
      totalMessages: 1,
      totalCost: 0,
      totalTokens: { input: 100, output: 10, reasoning: 0, cache: { read: 300, write: 20 } },
      toolUsage: {},
      modelUsage: {},
      dateRange: { earliest: 0, latest: 0 },
      days: 1,
      costPerDay: 0,
      tokensPerSession: 430,
      medianTokensPerSession: 430,
      context: {
        requests: 1,
        system: 10,
        tools: 20,
        messages: 30,
        toolResults: 40,
        customMessages: 50,
        attachments: 60,
        total: 210,
      },
    })

    const output = lines.join("\n")
    expect(output).toContain("REQUEST CONTEXT")
    expect(output).toContain("Total Context")
    expect(output).toContain("Billable Input")
    expect(output).toContain("120")
    expect(output).toContain("Cached Input")
    expect(output).toContain("71.4%")
  })
})
