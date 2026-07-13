import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

describe("OpenAI Responses continuation", () => {
  const input = {
    enabled: "api-only",
    providerID: "openai",
    store: undefined,
  } as const

  test("rejects ChatGPT OAuth because Codex requests are stateless", () => {
    expect(
      LLM.shouldUseOpenAIResponsesContinuation({
        ...input,
        auth: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
      }),
    ).toBe(false)
  })

  test("allows API-key and environment-key OpenAI requests", () => {
    expect(LLM.shouldUseOpenAIResponsesContinuation(input)).toBe(true)
    expect(LLM.shouldUseOpenAIResponsesContinuation({ ...input, auth: { type: "api", key: "key" } })).toBe(true)
  })

  test("respects disabled continuation and explicit stateless requests", () => {
    expect(LLM.shouldUseOpenAIResponsesContinuation({ ...input, enabled: false })).toBe(false)
    expect(LLM.shouldUseOpenAIResponsesContinuation({ ...input, store: false })).toBe(false)
  })
})
