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

describe("LLM request variants", () => {
  const model = {
    id: "reasoning-model",
    providerID: "test",
    api: { id: "reasoning-model", url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 32_000 },
    status: "active",
    headers: {},
    options: { reasoningEffort: "medium", nested: { model: true } },
    variants: {
      low: { reasoningEffort: "low", smallOnly: true },
      high: { reasoningEffort: "high", nested: { variant: true }, variantOnly: true },
    },
  } as any

  test("selected variant wins over model and agent options", () => {
    expect(
      LLM.resolveRequestOptions({
        model,
        agent: { options: { reasoningEffort: "low", nested: { agent: true } } },
        sessionID: "session-variant",
        variant: "high",
      }),
    ).toMatchObject({
      reasoningEffort: "high",
      nested: { model: true, agent: true, variant: true },
      variantOnly: true,
    })
  })

  test("small-model requests use the first model variant instead of the selected variant", () => {
    const result = LLM.resolveRequestOptions({
      model,
      agent: { options: {} },
      sessionID: "session-small",
      variant: "high",
      small: true,
    })
    expect(result.smallOnly).toBe(true)
    expect(result.variantOnly).toBeUndefined()
    expect(result.reasoningEffort).toBe("medium")
  })
})
