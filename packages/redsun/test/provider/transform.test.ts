import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"

const OUTPUT_TOKEN_MAX = 32000

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"

  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options(mockModel, sessionID, { setCacheKey: true })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options(mockModel, sessionID, { setCacheKey: false })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options(mockModel, sessionID, undefined)
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options(mockModel, sessionID, {})
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for openai provider by default", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options(openaiModel, sessionID, {})
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should allow disabling promptCacheKey for openai", () => {
    const model = {
      ...mockModel,
      providerID: "openai",
      api: { id: "gpt-4", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    }
    expect(ProviderTransform.options(model, sessionID, { setCacheKey: false }).promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for xAI by default", () => {
    const model = {
      ...mockModel,
      providerID: "xai",
      api: { id: "grok-4", url: "https://api.x.ai", npm: "@ai-sdk/xai" },
    }
    expect(ProviderTransform.options(model, sessionID, {}).promptCacheKey).toBe(sessionID)
    expect(ProviderTransform.options(model, sessionID, { setCacheKey: false }).promptCacheKey).toBeUndefined()
  })

  test("sets Muse Responses defaults", () => {
    const model = {
      ...mockModel,
      providerID: "meta",
      api: { id: "muse-spark-preview", url: "https://api.meta.ai", npm: "@ai-sdk/openai" },
    }
    expect(ProviderTransform.options(model, sessionID, {})).toMatchObject({
      promptCacheKey: sessionID,
      reasoningEffort: "xhigh",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      store: false,
    })
  })

  test("applies current Meta reasoning defaults to other Responses models", () => {
    const model = {
      ...mockModel,
      providerID: "meta",
      api: { id: "llama-4", url: "https://api.meta.ai", npm: "@ai-sdk/openai" },
    }
    expect(ProviderTransform.options(model, sessionID, {})).toMatchObject({
      reasoningEffort: "xhigh",
      reasoningSummary: "auto",
      store: false,
    })
  })

  test("sets store=false for xAI Responses", () => {
    const model = {
      ...mockModel,
      providerID: "custom-xai",
      api: { id: "grok-4", url: "https://api.x.ai", npm: "@ai-sdk/xai" },
    }
    expect(ProviderTransform.options(model, sessionID, {})).toMatchObject({
      promptCacheKey: sessionID,
      store: false,
    })
    expect(ProviderTransform.smallOptions(model)).toMatchObject({ store: false })
  })

  test("sets provider-specific cache and reasoning defaults", () => {
    const zai = {
      ...mockModel,
      providerID: "zai",
      api: { ...mockModel.api, id: "glm-5", npm: "@ai-sdk/openai-compatible" },
      capabilities: { ...mockModel.capabilities, reasoning: true },
    }
    expect(ProviderTransform.options(zai, sessionID, {})).toMatchObject({
      thinking: { type: "enabled", clear_thinking: false },
    })

    const azure = {
      ...mockModel,
      providerID: "azure",
      api: { ...mockModel.api, id: "gpt-5.6", npm: "@ai-sdk/azure" },
      capabilities: { ...mockModel.capabilities, reasoning: true },
    }
    expect(ProviderTransform.options(azure, sessionID, {})).toMatchObject({
      store: false,
      promptCacheKey: sessionID,
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    })

    const openrouter = {
      ...mockModel,
      providerID: "openrouter",
      api: { ...mockModel.api, id: "openai/gpt-5.6", npm: "@openrouter/ai-sdk-provider" },
    }
    expect(ProviderTransform.options(openrouter, sessionID, {})).toMatchObject({
      prompt_cache_key: sessionID,
      usage: { include: true },
    })

    const gateway = {
      ...mockModel,
      providerID: "gateway",
      api: { ...mockModel.api, id: "openai/gpt-5.6", npm: "@ai-sdk/gateway" },
    }
    expect(ProviderTransform.options(gateway, sessionID, {})).toMatchObject({
      gateway: { caching: "auto" },
    })
  })

  test("uses the first model variant for small-model requests", () => {
    const model = {
      ...mockModel,
      providerID: "openai",
      api: { ...mockModel.api, id: "gpt-5.6", npm: "@ai-sdk/openai" },
      variants: {
        low: { reasoningEffort: "low", reasoningSummary: "auto" },
        high: { reasoningEffort: "high" },
      },
    }
    expect(ProviderTransform.smallOptions(model)).toEqual({
      store: false,
      reasoningEffort: "low",
      reasoningSummary: "auto",
    })
  })

  test("applies GPT-5 reasoning defaults to Codex models", () => {
    const model = {
      ...mockModel,
      providerID: "openai",
      api: { ...mockModel.api, id: "gpt-5.3-codex", npm: "@ai-sdk/openai" },
      capabilities: { ...mockModel.capabilities, reasoning: true },
    }
    expect(ProviderTransform.options(model, sessionID, {})).toMatchObject({
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })
  })
})

describe("ProviderTransform reasoning variants", () => {
  const model = {
    id: "gpt-5.2",
    providerID: "openai",
    api: { id: "gpt-5.2", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: "GPT-5.2",
    family: "gpt-5",
    release_date: "2025-12-11",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("falls back to provider heuristics when catalog metadata is absent", () => {
    expect(Object.keys(ProviderTransform.variants(model))).toEqual(["none", "low", "medium", "high", "xhigh"])
  })

  test("catalog effort metadata determines the exposed variants", () => {
    expect(
      ProviderTransform.reasoningVariants(
        { reasoning_options: [{ type: "effort", values: ["low", "high"] }] } as any,
        model,
      ),
    ).toEqual({
      low: {
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
      high: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    })
  })

  test("budget variants stay below the model output limit", () => {
    const anthropic = {
      ...model,
      id: "claude-sonnet",
      providerID: "anthropic",
      api: { ...model.api, id: "claude-sonnet", npm: "@ai-sdk/anthropic" },
      limit: { context: 200_000, output: 1_000 },
    }
    expect(
      ProviderTransform.reasoningVariants(
        { reasoning_options: [{ type: "budget_tokens", min: 800, max: 5_000 }] } as any,
        anthropic,
      ),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 800 } },
      max: { thinking: { type: "enabled", budgetTokens: 999 } },
    })
  })

  test("gateway metadata routing uses the upstream API id", () => {
    const gateway = {
      ...model,
      id: "friendly-name",
      providerID: "gateway",
      api: { ...model.api, id: "anthropic/claude-sonnet-5", npm: "@ai-sdk/gateway" },
    }
    expect(
      ProviderTransform.reasoningVariants(
        { reasoning_options: [{ type: "effort", values: ["high"] }] } as any,
        gateway,
      ),
    ).toEqual({
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    })
  })

  test("falls back to provider-specific variants for OpenAI-compatible models", () => {
    const compatible = {
      ...model,
      id: "deepseek-v4",
      providerID: "deepseek",
      api: { ...model.api, id: "deepseek-v4", npm: "@ai-sdk/openai-compatible" },
    }
    expect(Object.keys(ProviderTransform.variants(compatible))).toEqual(["low", "medium", "high", "max"])
  })
})

describe("ProviderTransform.maxOutputTokens", () => {
  test("returns 32k when modelLimit > 32k", () => {
    const modelLimit = 100000
    const result = ProviderTransform.maxOutputTokens("@ai-sdk/openai", {}, modelLimit, OUTPUT_TOKEN_MAX)
    expect(result).toBe(OUTPUT_TOKEN_MAX)
  })

  test("returns modelLimit when modelLimit < 32k", () => {
    const modelLimit = 16000
    const result = ProviderTransform.maxOutputTokens("@ai-sdk/openai", {}, modelLimit, OUTPUT_TOKEN_MAX)
    expect(result).toBe(16000)
  })

  describe("azure", () => {
    test("returns 32k when modelLimit > 32k", () => {
      const modelLimit = 100000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/azure", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(OUTPUT_TOKEN_MAX)
    })

    test("returns modelLimit when modelLimit < 32k", () => {
      const modelLimit = 16000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/azure", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(16000)
    })
  })

  describe("bedrock", () => {
    test("returns 32k when modelLimit > 32k", () => {
      const modelLimit = 100000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/amazon-bedrock", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(OUTPUT_TOKEN_MAX)
    })

    test("returns modelLimit when modelLimit < 32k", () => {
      const modelLimit = 16000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/amazon-bedrock", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(16000)
    })
  })

  describe("anthropic without thinking options", () => {
    test("returns 32k when modelLimit > 32k", () => {
      const modelLimit = 100000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/anthropic", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(OUTPUT_TOKEN_MAX)
    })

    test("returns modelLimit when modelLimit < 32k", () => {
      const modelLimit = 16000
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/anthropic", {}, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(16000)
    })
  })

  describe("anthropic with thinking options", () => {
    test("returns 32k when budgetTokens + 32k <= modelLimit", () => {
      const modelLimit = 100000
      const options = {
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      }
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/anthropic", options, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(OUTPUT_TOKEN_MAX)
    })

    test("returns modelLimit - budgetTokens when budgetTokens + 32k > modelLimit", () => {
      const modelLimit = 50000
      const options = {
        thinking: {
          type: "enabled",
          budgetTokens: 30000,
        },
      }
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/anthropic", options, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(20000)
    })

    test("returns 32k when thinking type is not enabled", () => {
      const modelLimit = 100000
      const options = {
        thinking: {
          type: "disabled",
          budgetTokens: 10000,
        },
      }
      const result = ProviderTransform.maxOutputTokens("@ai-sdk/anthropic", options, modelLimit, OUTPUT_TOKEN_MAX)
      expect(result).toBe(OUTPUT_TOKEN_MAX)
    })
  })
})

describe("ProviderTransform.schema - gemini array items", () => {
  test("adds missing items for array properties", () => {
    const geminiModel = {
      providerID: "google",
      api: {
        id: "gemini-3-pro",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array", items: { type: "string" } },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nodes.items).toBeDefined()
    expect(result.properties.edges.items.type).toBe("string")
  })
})

describe("ProviderTransform.providerOptions", () => {
  test("adds forceReasoning for OpenAI reasoning requests", () => {
    const result = ProviderTransform.providerOptions(
      {
        providerID: "openai",
        api: { id: "gpt-5", npm: "@ai-sdk/openai" },
        capabilities: { reasoning: true },
      } as any,
      { reasoningEffort: "medium" },
    )

    expect(result.openai.forceReasoning).toBe(true)
    expect(result.openai.reasoningEffort).toBe("medium")
  })

  test("passes Azure options under openai and azure namespaces", () => {
    const result = ProviderTransform.providerOptions(
      {
        providerID: "azure",
        api: { id: "gpt-5", npm: "@ai-sdk/azure" },
        capabilities: { reasoning: true },
      } as any,
      { reasoningEffort: "low" },
    )

    expect(result.openai.forceReasoning).toBe(true)
    expect(result.azure.forceReasoning).toBe(true)
    expect(result.azure.reasoningEffort).toBe("low")
  })

  test("does not rewrite OpenRouter low effort to none", () => {
    const result = ProviderTransform.providerOptions(
      {
        providerID: "openrouter",
        api: { id: "openai/gpt-5-mini", npm: "@openrouter/ai-sdk-provider" },
        capabilities: { reasoning: true },
      } as any,
      { reasoning: { effort: "low" } },
    )

    expect(result.openrouter.reasoning.effort).toBe("low")
  })
})

describe("ProviderTransform.isContextOverflow", () => {
  test("recognizes Z.AI token limit errors", () => {
    expect(ProviderTransform.isContextOverflow("tokens in request more than max tokens allowed")).toBe(true)
    expect(ProviderTransform.isContextOverflow("invalid api key")).toBe(false)
  })
})

describe("ProviderTransform.schema - openai supported schema subset", () => {
  const openaiModel = {
    providerID: "openai",
    api: {
      id: "gpt-4.1",
      npm: "@ai-sdk/openai",
    },
  } as any

  const azureModel = {
    providerID: "azure",
    api: {
      id: "gpt-4.1",
      npm: "@ai-sdk/azure",
    },
  } as any

  test("lowers boolean schemas and const values", () => {
    const result = ProviderTransform.schema(openaiModel, {
      type: "object",
      properties: {
        enabled: true,
        mode: { const: "fast" },
      },
      required: ["enabled", "mode", 42],
    } as any) as any

    expect(result).toEqual({
      type: "object",
      properties: {
        enabled: { type: "string" },
        mode: { enum: ["fast"], type: "string" },
      },
      required: ["enabled", "mode"],
    })
  })

  test("adds object properties and array items when omitted", () => {
    const result = ProviderTransform.schema(openaiModel, {
      type: "object",
      properties: {
        nested: { type: "object" },
        list: { type: "array" },
      },
    } as any) as any

    expect(result.properties.nested.properties).toEqual({})
    expect(result.properties.list.items).toEqual({ type: "string" })
  })

  test("infers types from supported JSON schema keywords", () => {
    const result = ProviderTransform.schema(azureModel, {
      properties: {
        count: { minimum: 1 },
        tags: { items: { type: "string" } },
      },
      required: ["count"],
    } as any) as any

    expect(result.type).toBe("object")
    expect(result.properties.count.type).toBe("number")
    expect(result.properties.tags.type).toBe("array")
    expect(result.properties.tags.items).toEqual({ type: "string" })
  })

  test("keeps refs, defs, enums, and composition keys in sanitized form", () => {
    const result = ProviderTransform.schema(openaiModel, {
      type: "object",
      properties: {
        choice: {
          anyOf: [{ $ref: "#/$defs/Choice" }, false],
        },
      },
      $defs: {
        Choice: { enum: ["a", "b"] },
      },
    } as any) as any

    expect(result.properties.choice.anyOf).toEqual([{ $ref: "#/$defs/Choice" }, { type: "string" }])
    expect(result.$defs.Choice).toEqual({ enum: ["a", "b"], type: "string" })
  })

  test("does not sanitize non-openai providers", () => {
    const schema = { type: "object", properties: { enabled: true } } as any
    const result = ProviderTransform.schema(
      {
        providerID: "anthropic",
        api: { id: "claude-sonnet", npm: "@ai-sdk/anthropic" },
      } as any,
      schema,
    ) as any

    expect(result.properties.enabled).toBe(true)
  })

  test("trims doc-only schema fields and long descriptions", () => {
    const result = ProviderTransform.schema(openaiModel, {
      type: "object",
      description: "x".repeat(1000),
      examples: [{ ignored: true }],
      markdownDescription: "ignored",
      $comment: "ignored",
      properties: {
        value: {
          type: "string",
          description: "short",
          examples: ["ignored"],
        },
      },
    } as any) as any

    expect(result.description).toContain("[redsun: context item truncated]")
    expect(result.examples).toBeUndefined()
    expect(result.markdownDescription).toBeUndefined()
    expect(result.$comment).toBeUndefined()
    expect(result.properties.value.examples).toBeUndefined()
  })
})

describe("ProviderTransform.message - Devstral tool calls", () => {
  test("normalizes tool call IDs for Devstral on compatible providers", () => {
    const result = ProviderTransform.message(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_123456789",
              toolName: "bash",
              input: { command: "echo hello" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_123456789",
              toolName: "bash",
              output: { type: "text", value: "hello" },
            },
          ],
        },
      ] as any,
      {
        providerID: "openrouter",
        api: { id: "mistralai/DEVSTRAL-small", npm: "@openrouter/ai-sdk-provider" },
      } as any,
    ) as any[]

    expect(result[0].content[0].toolCallId).toBe("call12345")
    expect(result[1].content[0].toolCallId).toBe("call12345")
  })
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, {
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "DeepSeek Chat",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: {
          field: "reasoning_content",
        },
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2023-04-01",
    })

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Non-DeepSeek providers leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, {
      id: "openai/gpt-4",
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      name: "GPT-4",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.03,
        output: 0.06,
        cache: { read: 0.001, write: 0.002 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2023-04-01",
    })

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - empty image handling", () => {
  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("replaces oversized data attachments with bounded text notice", () => {
    const hugeBase64 = "a".repeat(8 * 1024 * 1024)
    const result = ProviderTransform.message(
      [
        {
          role: "user",
          content: [{ type: "image", image: `data:image/png;base64,${hugeBase64}` }],
        },
      ] as any[],
      mockModel,
    )

    expect((result[0].content as any[])[0].type).toBe("text")
    expect((result[0].content as any[])[0].text).toContain("exceeds")
  })
})

describe("ProviderTransform.message - cache placement", () => {
  const anthropicModel = {
    providerID: "anthropic",
    api: { id: "claude-sonnet", npm: "@ai-sdk/anthropic" },
    capabilities: { input: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false },
  } as any

  test("does not mark volatile system context as cacheable", () => {
    const msgs = [
      { role: "system", content: "stable one" },
      { role: "system", content: "stable two" },
      { role: "system", content: "<env_dynamic>\n</env_dynamic>\n<files>\nfoo\n</files>" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel)

    expect((result[0].providerOptions?.anthropic as any)?.cacheControl?.type).toBe("ephemeral")
    expect((result[1].providerOptions?.anthropic as any)?.cacheControl?.type).toBe("ephemeral")
    expect(result[2].providerOptions).toBeUndefined()
  })

  test("marks OpenRouter messages with provider-specific cache metadata", () => {
    const result = ProviderTransform.message(
      [
        { role: "system", content: "stable" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ] as any[],
      {
        providerID: "openrouter",
        api: { id: "openrouter/model", npm: "@openrouter/ai-sdk-provider" },
        capabilities: { input: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false },
      } as any,
    )

    expect((result[0].providerOptions?.openrouter as any)?.cache_control?.type).toBe("ephemeral")
    expect(((result[1].content as any[])[0].providerOptions?.openrouter as any)?.cache_control?.type).toBe("ephemeral")
  })

  test("OpenAI-compatible cache control is opt-in", () => {
    const model = {
      providerID: "deepseek",
      api: { id: "deepseek-chat", npm: "@ai-sdk/openai-compatible" },
      capabilities: { input: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false },
    } as any

    const disabled = ProviderTransform.message([{ role: "system", content: "stable" }] as any[], model)
    const enabled = ProviderTransform.message([{ role: "system", content: "stable" }] as any[], model, {
      openaiCompatibleCacheControl: true,
    })

    expect(disabled[0].providerOptions).toBeUndefined()
    expect((enabled[0].providerOptions?.openaiCompatible as any)?.cache_control?.type).toBe("ephemeral")
  })
})

describe("ProviderTransform.message - provider metadata", () => {
  const model = {
    id: "github-copilot/gpt-5.5",
    providerID: "github-copilot",
    api: { id: "gpt-5.5", npm: "@ai-sdk/github-copilot" },
    capabilities: { input: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false },
  } as any

  test("remaps stored provider IDs and removes stale stateless item IDs", () => {
    const result = ProviderTransform.message(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "bash",
              input: {},
              providerOptions: {
                "github-copilot": { itemId: "fc_123", reasoningEffort: "medium" },
              },
            },
          ],
        },
      ] as any[],
      model,
      { store: false },
    ) as any[]

    expect(result[0].content[0].providerOptions).toEqual({ copilot: { reasoningEffort: "medium" } })
  })

  test("preserves item IDs when response storage is enabled", () => {
    const result = ProviderTransform.message(
      [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking",
              providerOptions: { copilot: { itemId: "rs_123", reasoningEffort: "high" } },
            },
          ],
        },
      ] as any[],
      model,
      { store: true },
    ) as any[]

    expect(result[0].content[0].providerOptions.copilot.itemId).toBe("rs_123")
  })
})

describe("ProviderTransform.message - request validity", () => {
  const model = (npm: string, overrides: Record<string, any> = {}) =>
    ({
      id: "model",
      providerID: "provider",
      api: { id: "model", npm },
      capabilities: { input: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false },
      ...overrides,
    }) as any

  test("replaces unpaired UTF-16 surrogates throughout model-visible text", () => {
    const result = ProviderTransform.message(
      [
        { role: "system", content: "bad\uD800system" },
        { role: "user", content: [{ type: "text", text: "bad\uDC00user" }] },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call", toolName: "bash", output: { type: "text", value: "bad\uD800tool" } },
          ],
        },
      ] as any[],
      model("@ai-sdk/openai-compatible"),
    ) as any[]

    expect(result[0].content).toBe("bad\uFFFDsystem")
    expect(result[1].content[0].text).toBe("bad\uFFFDuser")
    expect(result[2].content[0].output.value).toBe("bad\uFFFDtool")
  })

  test.each([
    ["@ai-sdk/anthropic", "anthropic"],
    ["@ai-sdk/amazon-bedrock", "bedrock"],
  ])("filters empty %s messages but preserves signed reasoning", (npm, key) => {
    const result = ProviderTransform.message(
      [
        { role: "user", content: "" },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "", providerOptions: { [key]: { signature: "signed" } } }],
        },
      ] as any[],
      model(npm),
    ) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions[key].signature).toBe("signed")
  })

  test("replays empty DeepSeek reasoning metadata for tool-call turns", () => {
    const result = ProviderTransform.message(
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call", toolName: "bash", input: {} }],
        },
      ] as any[],
      model("@ai-sdk/openai-compatible", {
        api: { id: "deepseek-chat", npm: "@ai-sdk/openai-compatible" },
        capabilities: {
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: { field: "reasoning_content" },
        },
      }),
    ) as any[]

    expect(result[0].content).toHaveLength(1)
    expect(result[0].providerOptions.openaiCompatible.reasoning_content).toBe("")
  })

  test("uses the catalog interleaved field and leaves OpenRouter messages native", () => {
    const input = [{ role: "assistant", content: [{ type: "reasoning", text: "details" }] }] as any[]
    const compatible = ProviderTransform.message(
      structuredClone(input),
      model("@ai-sdk/openai-compatible", {
        capabilities: {
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: { field: "reasoning_details" },
        },
      }),
    ) as any[]
    const openrouter = ProviderTransform.message(
      structuredClone(input),
      model("@openrouter/ai-sdk-provider", {
        providerID: "openrouter",
        capabilities: {
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: { field: "reasoning_details" },
        },
      }),
    ) as any[]

    expect(compatible[0].providerOptions.openaiCompatible.reasoning_details).toBe("details")
    expect(compatible[0].content).toEqual([])
    expect(openrouter[0].content[0].type).toBe("reasoning")
  })
})
