import type { APICallError, ModelMessage } from "ai"
import { unique } from "remeda"
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
  function normalizeMessages(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
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
    if (model.providerID === "mistral" || model.api.id.toLowerCase().includes("mistral")) {
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

    if (
      model.capabilities.interleaved &&
      typeof model.capabilities.interleaved === "object" &&
      model.capabilities.interleaved.field === "reasoning_content"
    ) {
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // Include reasoning_content directly on the message for all assistant messages
          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  reasoning_content: reasoningText,
                },
              },
            }
          }

          return {
            ...msg,
            content: filteredContent,
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

  export function message(msgs: ModelMessage[], model: Provider.Model, providerOptions?: Record<string, any>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@openrouter/ai-sdk-provider" ||
      (model.api.npm === "@ai-sdk/openai-compatible" && providerOptions?.openaiCompatibleCacheControl === true)
    ) {
      msgs = applyCaching(msgs, model)
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      if (id.includes("thinking")) return 1.0
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 0.9
      return 0.95
    }
    if (id.includes("gemini")) return 0.95
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) return 20
    if (id.includes("gemini")) return 64
    return undefined
  }

  export function options(
    model: Provider.Model,
    sessionID: string,
    providerOptions?: Record<string, any>,
  ): Record<string, any> {
    const result: Record<string, any> = {}

    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      model.providerID === "baseten"
    ) {
      result["chat_template_args"] = { enable_thinking: true }
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

    if (
      model.providerID === "meta" &&
      model.api.npm === "@ai-sdk/openai" &&
      model.api.id.toLowerCase().includes("muse-spark")
    ) {
      result["reasoningEffort"] = "high"
      result["reasoningSummary"] = "auto"
      result["include"] = ["reasoning.encrypted_content"]
    }

    if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
      if (model.providerID.includes("codex")) {
        result["store"] = false
      }

      if (!model.api.id.includes("codex") && !model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
      }

      if (model.api.id.endsWith("gpt-5.") && model.providerID !== "azure") {
        result["textVerbosity"] = "low"
      }

    }
    return result
  }

  export function smallOptions(model: Provider.Model) {
    const options: Record<string, any> = {}

    if (model.providerID === "openai" || model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.")) {
        options["reasoningEffort"] = "low"
      } else {
        options["reasoningEffort"] = "minimal"
      }
    }
    if (model.providerID === "google") {
      options["thinkingConfig"] = {
        thinkingBudget: 0,
      }
    }

    return options
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
