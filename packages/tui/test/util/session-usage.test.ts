import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { fitSessionUsage, sessionUsage } from "../../src/util/session-usage"

const model = { providerID: "anthropic", id: "claude" }

function assistant(tokens: { input: number; output: number; read?: number; write?: number }): SessionMessageInfo {
  return {
    type: "assistant",
    id: `msg_${tokens.input}_${tokens.output}`,
    agent: "build",
    model,
    content: [],
    time: { created: 0 },
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
  } as unknown as SessionMessageInfo
}

test("reads the latest turn's context and the session's cost", () => {
  const usage = sessionUsage({
    messages: [assistant({ input: 1_000, output: 100 }), assistant({ input: 4_000, output: 500 })],
    contextLimit: () => 10_000,
    cost: 1.5,
  })
  expect(usage?.context).toBe("4.5K (45%)")
  expect(usage?.percent).toBe("45%")
  expect(usage?.cost).toBe("$1.50")
})

test("omits the percentage when the model's context limit is unknown", () => {
  const usage = sessionUsage({ messages: [assistant({ input: 900, output: 100 })], cost: 0 })
  expect(usage?.context).toBe("1.0K")
  expect(usage?.percent).toBeUndefined()
  expect(usage?.cost).toBeUndefined()
})

test("takes the cache ratio across the session, not the last turn", () => {
  // One turn's ratio swings too hard to read at a glance.
  const usage = sessionUsage({
    messages: [assistant({ input: 100, output: 10, write: 900 }), assistant({ input: 100, output: 10, read: 900 })],
    cost: 0,
  })
  expect(usage?.cache).toBe("cache 45%")
})

test("says nothing until a turn has produced output", () => {
  expect(sessionUsage({ messages: [], cost: 0 })).toBeUndefined()
  expect(sessionUsage({ messages: [assistant({ input: 100, output: 0 })], cost: 0 })).toBeUndefined()
})

test("gives ground as the row narrows", () => {
  const usage = { context: "120.0K (60%)", percent: "60%", cache: "cache 45%", cost: "$4.23" }
  expect(fitSessionUsage(usage, 80)).toBe("120.0K (60%) · cache 45% · $4.23")
  // The full token count is the first thing to go; the percentage carries it.
  expect(fitSessionUsage(usage, 25)).toBe("60% · cache 45% · $4.23")
  expect(fitSessionUsage(usage, 16)).toBe("60% · cache 45%")
  expect(fitSessionUsage(usage, 5)).toBe("60%")
  // Below the shortest form it shows nothing rather than a truncated number.
  expect(fitSessionUsage(usage, 2)).toBeUndefined()
})
