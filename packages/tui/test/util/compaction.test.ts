import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { compactionSummary } from "../../src/util/compaction"

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: "ses_test",
  messageID: "msg_test",
  type: "text",
  text,
})

describe("compactionSummary", () => {
  test("joins text parts and ignores non-text parts", () => {
    const reasoning: Part = {
      id: "part_reasoning",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "reasoning",
      text: "internal reasoning",
      time: { start: 1 },
    }

    expect(
      compactionSummary([textPart("part_one", " First section "), reasoning, textPart("part_two", "Second section")]),
    ).toBe("First section\n\nSecond section")
  })
})
