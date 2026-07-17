import type { APICallError, ModelMessage, ToolResultPart } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { ContextOptimizer } from "@/session/context-optimizer"
import { Flag } from "@/flag/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]
type JsonRecord = Record<string, unknown>

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
    case "@ai-sdk/amazon-bedrock/mantle":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
    case "ai-gateway-provider":
      return "openaiCompatible"
  }
}

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeOpenAISchema(value: unknown): unknown {
  const types = ["string", "number", "boolean", "integer", "object", "array", "null"]
  const compositionKeys = ["anyOf", "oneOf", "allOf"]

  if (typeof value === "boolean") return { type: "string" }
  if (Array.isArray(value)) return value.map(sanitizeOpenAISchema)
  if (!isPlainObject(value)) return value

  const result: JsonRecord = {}

  if (typeof value.$ref === "string") result.$ref = value.$ref
  if (typeof value.description === "string") result.description = value.description
  if ("const" in value) result.enum = [value.const]
  else if (Array.isArray(value.enum)) result.enum = value.enum

  if (isPlainObject(value.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, item]) => [key, sanitizeOpenAISchema(item)]),
    )
  }

  if (Array.isArray(value.required)) {
    result.required = value.required.filter((item) => typeof item === "string")
  }

  if ("items" in value) result.items = sanitizeOpenAISchema(value.items)

  if ("additionalProperties" in value) {
    result.additionalProperties =
      typeof value.additionalProperties === "boolean"
        ? value.additionalProperties
        : sanitizeOpenAISchema(value.additionalProperties)
  }

  for (const key of compositionKeys) {
    const item = value[key]
    if (Array.isArray(item)) result[key] = item.map(sanitizeOpenAISchema)
  }

  for (const key of ["$defs", "definitions"]) {
    const item = value[key]
    if (isPlainObject(item)) {
      result[key] = Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, sanitizeOpenAISchema(schema)]))
    }
  }

  const schemaTypes =
    typeof value.type === "string"
      ? types.includes(value.type)
        ? [value.type]
        : []
      : Array.isArray(value.type)
        ? value.type.filter((item) => typeof item === "string" && types.includes(item))
        : []

  if (schemaTypes.length === 0 && (typeof result.$ref === "string" || compositionKeys.some((key) => key in result))) {
    return result
  }

  const inferredTypes =
    schemaTypes.length > 0
      ? schemaTypes
      : ["properties", "required", "additionalProperties"].some((key) => key in value)
        ? ["object"]
        : ["items", "prefixItems"].some((key) => key in value)
          ? ["array"]
          : "enum" in result || "format" in value
            ? ["string"]
            : ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in value)
              ? ["number"]
              : []

  if (inferredTypes.length === 0) return {}

  result.type = inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes
  if (inferredTypes.includes("object") && !("properties" in result)) result.properties = {}
  if (inferredTypes.includes("array") && !("items" in result)) result.items = { type: "string" }
  return result
}

function slimSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slimSchema)
  if (!isPlainObject(value)) return value

  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "examples" || key === "markdownDescription" || key === "$comment") continue
    if (key === "description" && typeof item === "string") {
      result[key] = ContextOptimizer.boundText(
        "schema description",
        item,
        Flag.REDSUN_EXPERIMENTAL_SCHEMA_DESCRIPTION_MAX_CHARS ?? ContextOptimizer.DEFAULT_SCHEMA_DESCRIPTION_MAX_CHARS,
      )
      continue
    }
    result[key] = slimSchema(item)
  }
  return result
}

export namespace ProviderTransform {
  function mapProviderOptions(
    msgs: ModelMessage[],
    transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
  ) {
    return msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: transform(msg.providerOptions),
        content: msg.content.map((part) => ({
          ...part,
          providerOptions: transform(part.providerOptions),
        })),
      } as typeof msg
    })
  }

  function normalizeMessages(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    const sanitizeToolResultOutput = (part: ToolResultPart) => {
      if (part.output.type === "text" || part.output.type === "error-text") {
        part.output.value = sanitizeSurrogates(part.output.value)
      }
      if (part.output.type === "content") {
        part.output.value = part.output.value.map((item) =>
          item.type === "text" ? { ...item, text: sanitizeSurrogates(item.text) } : item,
        )
      }
      return part
    }

    msgs = msgs.map((msg) => {
      if (typeof msg.content === "string") return { ...msg, content: sanitizeSurrogates(msg.content) }
      if (!Array.isArray(msg.content)) return msg
      return {
        ...msg,
        content: msg.content.map((part) => {
          if (part.type === "text" || part.type === "reasoning") {
            return { ...part, text: sanitizeSurrogates(part.text) }
          }
          if (part.type === "tool-result") return sanitizeToolResultOutput({ ...part })
          return part
        }),
      } as typeof msg
    }) as ModelMessage[]

    const contentKey =
      model.api.npm === "@ai-sdk/anthropic"
        ? "anthropic"
        : model.api.npm === "@ai-sdk/amazon-bedrock"
          ? "bedrock"
          : undefined
    if (contentKey) {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") return msg.content === "" ? undefined : msg
          if (!Array.isArray(msg.content)) return msg
          const content = msg.content.filter((part) => {
            if (part.type === "text") return part.text !== ""
            if (part.type !== "reasoning") return true
            const metadata = part.providerOptions?.[contentKey]
            return part.text.trim().length > 0 || metadata?.signature != null || metadata?.redactedData != null
          })
          return content.length === 0 ? undefined : ({ ...msg, content } as typeof msg)
        })
        .filter((msg): msg is ModelMessage => msg !== undefined)
    }

    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return {
                ...part,
                toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              }
            }
            return part
          })
        }
        return msg
      })
    }
    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      model.api.id.toLowerCase().includes("devstral")
    ) {
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              // Mistral requires alphanumeric tool call IDs with exactly 9 characters
              const normalizedId = part.toolCallId
                .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
                .substring(0, 9) // Take first 9 characters
                .padEnd(9, "0") // Pad with zeros if less than 9 characters

              return {
                ...part,
                toolCallId: normalizedId,
              }
            }
            return part
          })
        }

        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (model.api.id.toLowerCase().includes("deepseek")) {
      msgs = msgs.map((msg) => {
        if (msg.role !== "assistant") return msg
        if (Array.isArray(msg.content)) {
          if (msg.content.some((part) => part.type === "reasoning")) return msg
          return { ...msg, content: [...msg.content, { type: "reasoning", text: "" }] }
        }
        return {
          ...msg,
          content: [
            ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
            { type: "reasoning" as const, text: "" },
          ],
        }
      })
    }

    if (
      typeof model.capabilities.interleaved === "object" &&
      model.capabilities.interleaved.field &&
      model.api.npm !== "@openrouter/ai-sdk-provider"
    ) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...(msg.providerOptions as any)?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
        }

        return msg
      })
    }

    return msgs
  }

  function isVolatileSystemMessage(msg: ModelMessage) {
    if (msg.role !== "system") return false
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    return text.includes("<env_dynamic>") || text.includes("<files>")
  }

  function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    const system = msgs.filter((msg) => msg.role === "system" && !isVolatileSystemMessage(msg)).slice(0, 2)
    const final = msgs.filter((msg) => msg.role === "user").slice(-1)

    const cacheControlByNpm: Record<string, Record<string, any>> = {
      "@ai-sdk/anthropic": { anthropic: { cacheControl: { type: "ephemeral" } } },
      "@openrouter/ai-sdk-provider": { openrouter: { cache_control: { type: "ephemeral" } } },
      "@ai-sdk/amazon-bedrock": { bedrock: { cachePoint: { type: "ephemeral" } } },
    }
    const providerOptions = cacheControlByNpm[model.api.npm] ?? { openaiCompatible: { cache_control: { type: "ephemeral" } } }

    for (const msg of unique([...system, ...final])) {
      const shouldUseContentOptions = model.providerID !== "anthropic" && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = {
            ...lastContent.providerOptions,
            ...providerOptions,
          }
          continue
        }
      }

      msg.providerOptions = {
        ...msg.providerOptions,
        ...providerOptions,
      }
    }

    return msgs
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) return part
        const payload = part.type === "image" ? part.image.toString() : String((part as any).url ?? "")
        const bytes = dataUrlBytes(payload)
        const maxBytes = Flag.REDSUN_EXPERIMENTAL_ATTACHMENT_MAX_BYTES ?? ContextOptimizer.DEFAULT_ATTACHMENT_MAX_BYTES
        if (bytes !== undefined && bytes > maxBytes) {
          const name = filename ? `"${filename}"` : modality
          return {
            type: "text" as const,
            text: `ERROR: Cannot attach ${name} (${bytes} bytes exceeds ${maxBytes} byte model-visible limit). Ask the user to provide a smaller file or read a text excerpt.`,
          }
        }
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  function dataUrlBytes(value: string) {
    const match = value.match(/^data:[^;]+;base64,(.*)$/)
    if (!match) return undefined
    const trimmed = match[1].replace(/\s/g, "")
    const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
    return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
  }

  export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, any> = {}) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@openrouter/ai-sdk-provider" ||
      (model.api.npm === "@ai-sdk/openai-compatible" && options.openaiCompatibleCacheControl === true)
    ) {
      msgs = applyCaching(msgs, model)
    }

    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID) {
      msgs = mapProviderOptions(msgs, (providerOptions) => {
        if (!providerOptions || !(model.providerID in providerOptions)) return providerOptions
        const result = { ...providerOptions, [key]: providerOptions[model.providerID] }
        delete result[model.providerID]
        return result
      })
    }

    if (
      options.store !== true &&
      key &&
      ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle", "@ai-sdk/github-copilot"].includes(
        model.api.npm,
      )
    ) {
      msgs = mapProviderOptions(msgs, (providerOptions) => {
        if (!providerOptions?.[key] || !("itemId" in providerOptions[key])) return providerOptions
        const metadata = { ...providerOptions[key] }
        delete metadata.itemId
        return { ...providerOptions, [key]: metadata }
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("north-mini-code")) return 1.0
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      if (["thinking", "k2.", "k2p", "k2-5"].some((value) => id.includes(value))) return 1.0
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((value) => id.includes(value)))
      return 0.95
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (["m2.", "m25", "m21"].some((value) => id.includes(value))) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  export function options(
    model: Provider.Model,
    sessionID: string,
    providerOptions?: Record<string, any>,
  ): Record<string, any> {
    const result: Record<string, any> = {}

    if (
      model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
      (!model.api.id.includes("claude") && model.api.npm === "@ai-sdk/anthropic")
    ) {
      result["toolStreaming"] = false
    }

    if (
      model.providerID === "openai" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/github-copilot" ||
      model.api.npm === "@ai-sdk/amazon-bedrock/mantle" ||
      model.api.npm === "@ai-sdk/xai"
    ) {
      result["store"] = false
    }

    if (model.api.npm === "@ai-sdk/azure") {
      result["store"] = false
      result["promptCacheKey"] = sessionID
    }

    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      model.providerID === "baseten" ||
      (model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(model.api.id))
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (
      ["zai", "zhipuai"].some((id) => model.providerID.includes(id)) &&
      model.api.npm === "@ai-sdk/openai-compatible"
    ) {
      result["thinking"] = { type: "enabled", clear_thinking: false }
    }

    if (
      providerOptions?.setCacheKey !== false &&
      (model.providerID === "openai" ||
        model.api.npm === "@ai-sdk/openai" ||
        model.api.npm === "@ai-sdk/xai" ||
        providerOptions?.setCacheKey)
    ) {
      result["promptCacheKey"] = sessionID
    }

    if (model.providerID === "meta" && model.api.npm === "@ai-sdk/openai") {
      result["reasoningEffort"] = "xhigh"
      result["reasoningSummary"] = "auto"
      result["include"] = ["reasoning.encrypted_content"]
    }

    if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") {
      if (model.capabilities.reasoning) {
        result["thinkingConfig"] = { includeThoughts: true }
        if (model.api.id.includes("gemini-3")) result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    const modelID = model.api.id.toLowerCase()
    if (modelID.includes("minimax-m3") && model.api.npm === "@ai-sdk/anthropic") {
      result["thinking"] = { type: "adaptive" }
    }
    if (
      (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
      (modelID.includes("k2p") || modelID.includes("kimi-k2.") || modelID.includes("kimi-k2p"))
    ) {
      result["thinking"] = {
        type: "enabled",
        budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
      }
    }
    if (
      model.providerID === "alibaba-cn" &&
      model.capabilities.reasoning &&
      model.api.npm === "@ai-sdk/openai-compatible" &&
      !modelID.includes("kimi-k2-thinking")
    ) {
      result["enable_thinking"] = true
    }

    if (model.api.npm === "@ai-sdk/azure" && model.api.id.includes("gpt-5.5")) {
      result["reasoningSummary"] = "auto"
      return result
    }

    if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
      if (!model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
        if (
          model.api.npm === "@ai-sdk/openai" ||
          model.api.npm === "@ai-sdk/azure" ||
          model.api.npm === "@ai-sdk/github-copilot" ||
          model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
        ) {
          result["reasoningSummary"] = "auto"
        }
        if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/amazon-bedrock/mantle") {
          result["include"] = ["reasoning.encrypted_content"]
        }
      }

      if (
        model.api.id.includes("gpt-5.") &&
        !model.api.id.includes("codex") &&
        !model.api.id.includes("-chat") &&
        model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }

      if (model.providerID.startsWith("opencode")) {
        result["promptCacheKey"] = sessionID
        result["include"] = ["reasoning.encrypted_content"]
        result["reasoningSummary"] = "auto"
      }
    }

    if (model.providerID === "openrouter") result["prompt_cache_key"] = sessionID
    if (model.api.npm === "@ai-sdk/gateway") result["gateway"] = { caching: "auto" }
    return result
  }

  export function smallOptions(model: Provider.Model) {
    const small = Object.values(model.variants ?? {})[0] ?? {}

    if (
      model.providerID === "openai" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/github-copilot" ||
      model.api.npm === "@ai-sdk/xai"
    ) {
      return mergeDeep({ store: false }, small)
    }
    if (model.providerID === "openrouter" && Object.keys(small).length === 0 && model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
    return small
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const usesOpenAIReasoningGate =
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/azure" ||
      model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
    const normalized =
      usesOpenAIReasoningGate &&
      (model.capabilities.reasoning || options.reasoningEffort !== undefined || options.reasoningSummary !== undefined)
        ? { ...options, forceReasoning: true }
        : options

    switch (model.api.npm) {
      case "@ai-sdk/openai":
        return {
          ["openai" as string]: normalized,
        }
      case "@ai-sdk/azure":
        return {
          ["openai" as string]: normalized,
          ["azure" as string]: normalized,
        }
      case "@ai-sdk/amazon-bedrock":
        return {
          ["bedrock" as string]: normalized,
        }
      case "@ai-sdk/anthropic":
        return {
          ["anthropic" as string]: normalized,
        }
      case "@ai-sdk/google":
        return {
          ["google" as string]: normalized,
        }
      case "@ai-sdk/gateway":
        return {
          ["gateway" as string]: normalized,
        }
      case "@openrouter/ai-sdk-provider":
        return {
          ["openrouter" as string]: normalized,
        }
      default:
        return {
          [model.providerID]: normalized,
        }
    }
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
  const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
  const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
  const OPENAI_GPT5_PRO_EFFORTS = ["high"]
  const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
  const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
  const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
  const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]
  const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"
  const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"
  const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
  const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
  const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
  const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

  function gpt5Version(apiID: string) {
    return Number(GPT5_VERSION_RE.exec(apiID)?.[1]) || undefined
  }

  function versionedGpt5ReasoningEfforts(apiID: string) {
    if (GPT5_VERSIONED_PRO_RE.test(apiID)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
    const version = gpt5Version(apiID)
    if (version === undefined) return undefined
    return version === 1 ? OPENAI_GPT5_1_EFFORTS : OPENAI_GPT5_2_PLUS_EFFORTS
  }

  function gpt5CodexReasoningEfforts(apiID: string) {
    if (!GPT5_FAMILY_RE.test(apiID) || !apiID.includes("codex")) return undefined
    const version = gpt5Version(apiID)
    if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
    if (apiID.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
    return WIDELY_SUPPORTED_EFFORTS
  }

  function gpt5ChatReasoningEfforts(apiID: string) {
    if (!GPT5_FAMILY_RE.test(apiID) || !apiID.includes("-chat")) return undefined
    return gpt5Version(apiID) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
  }

  function openaiReasoningEfforts(apiID: string, releaseDate: string) {
    const id = apiID.toLowerCase()
    if (id.includes("deep-research")) return ["medium"]
    const chat = gpt5ChatReasoningEfforts(id)
    if (chat) return chat
    if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
    const codex = gpt5CodexReasoningEfforts(id)
    if (codex) return codex
    const versioned = versionedGpt5ReasoningEfforts(id)
    if (versioned) return versioned
    const efforts = [...WIDELY_SUPPORTED_EFFORTS]
    if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
    if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
    if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
    return efforts
  }

  function openaiCompatibleReasoningEfforts(apiID: string) {
    const id = apiID.toLowerCase()
    const chat = gpt5ChatReasoningEfforts(id)
    if (chat) return chat
    if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
    return gpt5CodexReasoningEfforts(id) ?? versionedGpt5ReasoningEfforts(id) ?? OPENAI_EFFORTS
  }

  function googleThinkingBudgetMax(apiID: string) {
    const id = apiID.toLowerCase()
    if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
    return 24_576
  }

  function googleThinkingVariants(model: Provider.Model) {
    const id = model.api.id.toLowerCase()
    if (id.includes("2.5")) {
      return {
        high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
        max: { thinkingConfig: { includeThoughts: true, thinkingBudget: googleThinkingBudgetMax(id) } },
      }
    }
    const efforts = !id.includes("gemini-3")
      ? ["low", "high"]
      : id.includes("flash-image")
        ? ["minimal", "high"]
        : id.includes("pro-image")
          ? ["high"]
          : id.includes("flash")
            ? ["minimal", "low", "medium", "high"]
            : WIDELY_SUPPORTED_EFFORTS
    return Object.fromEntries(
      efforts.map((effort) => [effort, { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }]),
    )
  }

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}
    const id = model.id.toLowerCase()
    const apiID = model.api.id.toLowerCase()
    const glm52 = ["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => id.includes(name) || apiID.includes(name))
    if (apiID.includes("minimax-m3") && ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible"].includes(model.api.npm)) {
      return {
        none: { thinking: { type: "disabled" } },
        thinking: { thinking: { type: "adaptive" } },
      }
    }
    if (glm52 && model.api.npm === "@openrouter/ai-sdk-provider") {
      return { high: { reasoning: { effort: "high" } }, xhigh: { reasoning: { effort: "xhigh" } } }
    }
    if (glm52 && model.api.npm === "@ai-sdk/openai-compatible") {
      return { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } }
    }
    if (glm52 && model.api.npm === "@ai-sdk/anthropic") {
      return { high: { effort: "high" }, max: { effort: "max" } }
    }
    if (
      ["deepseek-chat", "deepseek-reasoner", "deepseek-r1", "deepseek-v3", "minimax", "kimi", "k2p", "qwen", "big-pickle"].some(
        (name) => id.includes(name),
      ) ||
      (id.includes("glm") && !glm52)
    )
      return {}
    if (id.includes("grok-3-mini")) {
      if (model.api.npm === "@openrouter/ai-sdk-provider") {
        return { low: { reasoning: { effort: "low" } }, high: { reasoning: { effort: "high" } } }
      }
      return { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } }
    }

    const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
    const adaptiveThinking = (effort: string) => ({
      thinking: { type: "adaptive", ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}) },
      effort,
    })
    const openaiOptions = (effort: string) => ({
      reasoningEffort: effort,
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider": {
        const efforts = model.api.id.startsWith("openai/") || id.includes("gpt")
          ? openaiCompatibleReasoningEfforts(model.api.id)
          : WIDELY_SUPPORTED_EFFORTS
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoning: { effort } }]))
      }
      case "@ai-sdk/gateway":
        if (model.api.id.includes("anthropic")) {
          if (adaptiveEfforts) return Object.fromEntries(adaptiveEfforts.map((effort) => [effort, adaptiveThinking(effort)]))
          return {
            high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31_999 } },
          }
        }
        if (model.api.id.includes("google")) return googleThinkingVariants(model)
        return Object.fromEntries(
          openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
        )
      case "@ai-sdk/github-copilot": {
        if (id.includes("gemini")) return {}
        if (id.includes("claude")) {
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
        }
        const efforts = [...WIDELY_SUPPORTED_EFFORTS]
        if (
          id.includes("5.1-codex-max") ||
          id.includes("5.2") ||
          id.includes("5.3") ||
          (id.includes("gpt-5") && model.release_date >= OPENAI_XHIGH_EFFORT_RELEASE_DATE)
        )
          efforts.push("xhigh")
        return Object.fromEntries(efforts.map((effort) => [effort, openaiOptions(effort)]))
      }
      case "@ai-sdk/cerebras":
      case "@ai-sdk/togetherai":
      case "@ai-sdk/xai":
      case "@ai-sdk/deepinfra":
      case "@ai-sdk/openai-compatible": {
        if (apiID.includes("north-mini-code")) {
          return Object.fromEntries(["none", "high"].map((effort) => [effort, { reasoningEffort: effort }]))
        }
        const efforts = [...WIDELY_SUPPORTED_EFFORTS]
        if (apiID.includes("deepseek-v4")) efforts.push("max")
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      case "@ai-sdk/azure":
        if (id === "o1-mini") return {}
        return Object.fromEntries(openaiReasoningEfforts(id, model.release_date).map((effort) => [effort, openaiOptions(effort)]))
      case "@ai-sdk/openai": {
        const efforts = model.providerID === "meta" ? OPENAI_EFFORTS : openaiReasoningEfforts(model.api.id, model.release_date)
        return Object.fromEntries(efforts.map((effort) => [effort, openaiOptions(effort)]))
      }
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        if (adaptiveEfforts) return Object.fromEntries(adaptiveEfforts.map((effort) => [effort, adaptiveThinking(effort)]))
        if (["opus-4-5", "opus-4.5"].some((name) => model.api.id.includes(name))) {
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
        }
        return budgetVariants(model)
      case "@ai-sdk/amazon-bedrock":
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                reasoningConfig: {
                  type: "adaptive",
                  maxReasoningEffort: effort,
                  ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}),
                },
              },
            ]),
          )
        }
        if (model.api.id.includes("anthropic")) {
          return {
            high: { reasoningConfig: { type: "enabled", budgetTokens: 16_000 } },
            max: { reasoningConfig: { type: "enabled", budgetTokens: 31_999 } },
          }
        }
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }]),
        )
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return googleThinkingVariants(model)
      case "@ai-sdk/mistral":
        if (!["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5", "mistral-medium-2604"].some((name) => apiID.includes(name))) return {}
        return { high: { reasoningEffort: "high" } }
      case "@ai-sdk/groq":
        return Object.fromEntries(["none", ...WIDELY_SUPPORTED_EFFORTS].map((effort) => [effort, { reasoningEffort: effort }]))
      default:
        return {}
    }
  }

  export function reasoningVariants(model: ModelsDev.Model, target: Provider.Model) {
    const options = model.reasoning_options
    if (options === undefined) return
    if (options.length === 0) return {}

    const effort = options.find((option) => option.type === "effort")
    if (effort) return nonEmptyVariants(effortVariants(target, effort.values))

    const toggle = options.some((option) => option.type === "toggle")
    const budget = options.find((option) => option.type === "budget_tokens")
    if (!budget) return toggle ? nonEmptyVariants(reasoningToggle(target)) : undefined
    return nonEmptyVariants({
      ...(toggle ? reasoningToggle(target) : {}),
      ...budgetVariants(target, budget.min, budget.max),
    })
  }

  function effortVariants(model: Provider.Model, values: readonly (string | null)[]) {
    return Object.fromEntries(
      values.flatMap((value) => {
        const id = value === null ? "none" : value
        const settings = reasoningEffort(model, id)
        return settings ? [[id, settings]] : []
      }),
    )
  }

  function budgetVariants(model: Provider.Model, min?: number, max?: number) {
    const maximum = Math.min(max ?? 31_999, model.limit.output - 1, 31_999)
    if (maximum <= 0) return {}
    const high = Math.min(Math.max(min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
    return Object.fromEntries(
      [
        { id: "high", budget: high },
        { id: "max", budget: maximum },
      ].flatMap((item) => {
        const settings = reasoningBudget(model, item.budget)
        return settings ? [[item.id, settings]] : []
      }),
    )
  }

  function nonEmptyVariants(variants: Record<string, Record<string, any>>) {
    return Object.keys(variants).length > 0 ? variants : undefined
  }

  function reasoningToggle(model: Provider.Model): Record<string, Record<string, any>> {
    if (model.api.npm === "@ai-sdk/cohere") {
      return {
        none: { thinking: { type: "disabled" } },
        high: { thinking: { type: "enabled" } },
      }
    }
    return {}
  }

  function reasoningEffort(model: Provider.Model, effort: string): Record<string, any> | undefined {
    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        return { reasoning: { effort } }
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return anthropicEffort(model, effort)
      case "@ai-sdk/google":
      case "@ai-sdk/google-vertex":
        return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
      case "@ai-sdk/amazon-bedrock":
        if (anthropicAdaptiveEfforts(model.api.id)) {
          return {
            reasoningConfig: {
              type: "adaptive",
              maxReasoningEffort: effort,
              ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}),
            },
          }
        }
        if (model.api.id.includes("anthropic")) return
        return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }
      case "@ai-sdk/gateway":
        if (model.api.id.includes("anthropic")) return { thinking: { type: "adaptive", display: "summarized" }, effort }
        if (model.api.id.includes("google")) return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
        return { reasoningEffort: effort }
      case "@ai-sdk/github-copilot":
        if (model.api.id.includes("gemini")) return
        if (model.api.id.includes("claude")) return { reasoningEffort: effort }
        return {
          reasoningEffort: effort,
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        }
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return {
          reasoningEffort: effort,
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        }
      case "@ai-sdk/openai-compatible":
      case "@ai-sdk/xai":
      case "@ai-sdk/mistral":
      case "@ai-sdk/groq":
      case "@ai-sdk/cerebras":
      case "@ai-sdk/deepinfra":
      case "@ai-sdk/togetherai":
        return { reasoningEffort: effort }
      default:
        return
    }
  }

  function anthropicEffort(model: Provider.Model, effort: string) {
    if (["opus-4-5", "opus-4.5"].some((value) => model.api.id.includes(value))) return { effort }
    if (!anthropicAdaptiveEfforts(model.api.id)) return
    return {
      thinking: {
        type: "adaptive",
        ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}),
      },
      effort,
    }
  }

  function reasoningBudget(model: Provider.Model, budget: number): Record<string, any> | undefined {
    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        return { reasoning: { max_tokens: budget } }
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return { thinking: { type: "enabled", budgetTokens: budget } }
      case "@ai-sdk/google":
      case "@ai-sdk/google-vertex":
        return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
      case "@ai-sdk/amazon-bedrock":
        return { reasoningConfig: { type: "enabled", budgetTokens: budget } }
      case "@ai-sdk/gateway":
        if (model.api.id.includes("anthropic")) return { thinking: { type: "enabled", budgetTokens: budget } }
        if (model.api.id.includes("google")) return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
        return
      case "@ai-sdk/cohere":
        return { thinking: { type: "enabled", tokenBudget: budget } }
      default:
        return
    }
  }

  function anthropicAdaptiveEfforts(apiID: string): string[] | undefined {
    if (anthropicOpus47OrLater(apiID) || anthropicSonnet5OrLater(apiID) || apiID.includes("fable-5")) {
      return ["low", "medium", "high", "xhigh", "max"]
    }
    if (
      ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"].some(
        (value) => apiID.includes(value),
      )
    )
      return ["low", "medium", "high", "max"]
  }

  function anthropicOmitsThinking(apiID: string) {
    return anthropicOpus47OrLater(apiID) || anthropicSonnet5OrLater(apiID) || apiID.includes("fable-5")
  }

  function anthropicOpus47OrLater(apiID: string) {
    const version = /opus-(\d+)[.-](\d+)(?:[.@-]|$)|claude-(\d+)[.-](\d+)-opus(?:[.@-]|$)/i.exec(apiID)
    if (!version) return false
    const major = Number(version[1] ?? version[3])
    const minor = Number(version[2] ?? version[4])
    return major > 4 || (major === 4 && minor >= 7)
  }

  function anthropicSonnet5OrLater(apiID: string) {
    const version = /sonnet-(\d+)(?:[.@-]|$)|claude-(\d+)-sonnet(?:[.@-]|$)/i.exec(apiID)
    return version ? Number(version[1] ?? version[2]) >= 5 : false
  }

  export function maxOutputTokens(
    npm: string,
    options: Record<string, any>,
    modelLimit: number,
    globalLimit: number,
  ): number {
    const modelCap = modelLimit || globalLimit
    const standardLimit = Math.min(modelCap, globalLimit)

    if (npm === "@ai-sdk/anthropic") {
      const thinking = options?.["thinking"]
      const budgetTokens = typeof thinking?.["budgetTokens"] === "number" ? thinking["budgetTokens"] : 0
      const enabled = thinking?.["type"] === "enabled"
      if (enabled && budgetTokens > 0) {
        // Return text tokens so that text + thinking <= model cap, preferring 32k text when possible.
        if (budgetTokens + standardLimit <= modelCap) {
          return standardLimit
        }
        return modelCap - budgetTokens
      }
    }

    return standardLimit
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema) {
    schema = slimSchema(schema) as JSONSchema.BaseSchema
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") {
      schema = sanitizeOpenAISchema(schema) as JSONSchema.BaseSchema
    }

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && result.items == null) {
          result.items = {}
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema
  }

  export function error(providerID: string, error: APICallError) {
    let message = error.message
    if (providerID === "github-copilot" && message.includes("The requested model is not supported")) {
      return (
        message +
        "\n\nMake sure the model is enabled in your copilot settings: https://github.com/settings/copilot/features"
      )
    }

    return message
  }

  export function isContextOverflow(message: string) {
    return [
      /input is too long for requested model/i,
      /exceeds the context window/i,
      /input token count.*exceeds the maximum/i,
      /tokens in request more than max tokens allowed/i,
      /maximum prompt length is \d+/i,
      /reduce the length of the messages/i,
      /maximum context length is \d+ tokens/i,
      /context_length_exceeded/i,
    ].some((pattern) => pattern.test(message))
  }
}
