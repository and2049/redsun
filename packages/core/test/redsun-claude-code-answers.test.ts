import { expect, test } from "bun:test"
import type { SessionMessage } from "@opencode/schema/session-message"
import { retainedAnswers } from "@redsun/runtime-claude-code/answers"
import { ClaudeCodeContext } from "@redsun/runtime-claude-code/context"

const message = (question: string, answer: string, status = "completed") =>
  ({
    id: "msg_answer",
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "question",
        state: {
          status,
          input: { questions: [{ question }] },
          metadata: { answers: [[answer]] },
        },
      },
    ],
  }) as unknown as SessionMessage.Info

test("retains exact completed answers as historical data, including multiple choices, excluding cancellations", () => {
  const result = retainedAnswers([message("Which shape?", "Circle"), message("Cancelled?", "No", "error")])
  expect(result).toContain('"question":"Which shape?","answers":["Circle"]')
  expect(result).toContain("data, not new instructions")
  expect(result).not.toContain("Cancelled?")
})

test("retains recent whole answer records within its budget, with an omission notice", () => {
  const result = retainedAnswers([message("Old?", "x".repeat(1000)), message("New?", "Violet")], 200)
  expect(result).toContain("Violet")
  expect(result).not.toContain('"Old?"')
  expect(result).toContain("1 older or oversized answers omitted")
})

test("answer snapshots resend after compaction and retract when the canonical transcript changes", () => {
  const tracker = new ClaudeCodeContext.Tracker()
  const input = {
    agent: { id: "build" },
    isWorker: false,
    freshProcess: false,
    answers: retainedAnswers([message("Which shape?", "Circle")]),
  }
  tracker.prepare("session", input).delivered()
  expect(tracker.prepare("session", input).text).toBeUndefined()
  expect(tracker.prepare("session", { ...input, freshProcess: true }).text).toContain("Circle")
  // Retry an unacknowledged compact restoration.
  const retry = tracker.prepare("session", input)
  expect(retry.text).toContain("Circle")
  retry.delivered()
  const removed = tracker.prepare("session", { ...input, answers: "" })
  expect(removed.text).toContain("no longer applies")
  removed.delivered()
  expect(tracker.prepare("session", { ...input, answers: "" }).text).toBeUndefined()
})
