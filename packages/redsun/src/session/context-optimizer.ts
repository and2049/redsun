import type { ModelMessage, Tool } from "ai"
import { Flag } from "@/flag/flag"
import { Token } from "@/util/token"
import { Storage } from "@/storage/storage"

export namespace ContextOptimizer {
  export const DEFAULT_FRAGMENT_MAX_CHARS = 24_000
  export const DEFAULT_VOLATILE_MAX_CHARS = 12_000
  export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 12_000
  export const DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS = 4_000
  export const DEFAULT_TOOL_RESULT_REPLAY_MAX_CHARS = 48_000
  export const DEFAULT_TOOL_RESULT_REPLAY_KEEP_RECENT = 6
  export const DEFAULT_CUSTOM_MESSAGE_MAX_CHARS = 24_000
  export const DEFAULT_SCHEMA_DESCRIPTION_MAX_CHARS = 600
  export const DEFAULT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024

  const TRUNCATED = "[redsun: context item truncated]"
  const TOOL_SHORTENED = "[redsun: tool result shortened for model context]"
  const TOOL_REPLAY_OMITTED = "[redsun: older tool result omitted from model context]"
  const CUSTOM_OMITTED = "[redsun: older custom message omitted from model context]"

  export type Breakdown = ReturnType<typeof breakdown>

  export function boundText(label: string, text: string, maxChars = Flag.REDSUN_EXPERIMENTAL_CONTEXT_FRAGMENT_MAX_CHARS ?? DEFAULT_FRAGMENT_MAX_CHARS) {
    if (text.length <= maxChars) return text
    const omitted = text.length - maxChars
    return [
      text.slice(0, maxChars),
      "",
      `${TRUNCATED} ${label} exceeded ${maxChars} chars; omitted ${omitted} chars.`,
    ].join("\n")
  }

  export function boundVolatile(label: string, text: string) {
    return boundText(label, text, Flag.REDSUN_EXPERIMENTAL_VOLATILE_CONTEXT_MAX_CHARS ?? DEFAULT_VOLATILE_MAX_CHARS)
  }

  export function modelToolOutput(input: { partID: string; tool: string; output: string }) {
    const maxChars = Flag.REDSUN_EXPERIMENTAL_TOOL_OUTPUT_MAX_CHARS ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS
    if (input.output.length <= maxChars) return undefined

    const previewChars = Math.min(
      Flag.REDSUN_EXPERIMENTAL_TOOL_OUTPUT_PREVIEW_CHARS ?? DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
      maxChars,
    )
    const preview = input.output.slice(0, previewChars)
    return [
      TOOL_SHORTENED,
      `tool: ${input.tool}`,
      `part: ${input.partID}`,
      `full_output_chars: ${input.output.length}`,
      `preview_chars: ${preview.length}`,
      "",
      preview,
      "",
      `[redsun: full output remains stored in the session transcript for part ${input.partID}]`,
    ].join("\n")
  }

  function contentTextLength(part: any) {
    if (part.type === "text" || part.type === "reasoning") return String(part.text ?? "").length
    if (part.type === "tool-result") return JSON.stringify(part).length
    if (part.type === "file") return String(part.url ?? "").length
    if (part.type === "image") return String(part.image ?? "").length
    return JSON.stringify(part ?? "").length
  }

  function isToolResultPart(part: any) {
    return part?.type === "tool-result" || (typeof part?.type === "string" && part.type.startsWith("tool-") && part.state === "output-available")
  }

  function shortenedToolPart(part: any) {
    const id = part.toolCallId ?? part.toolCallId ?? part.toolName ?? part.type ?? "unknown"
    const text = [
      TOOL_REPLAY_OMITTED,
      `tool_call: ${id}`,
      "The full result remains stored in the local session transcript.",
    ].join("\n")
    if (part.type === "tool-result") return { ...part, result: text }
    return { ...part, output: text }
  }

  export function limitToolResultReplay(messages: ModelMessage[]): ModelMessage[] {
    const maxChars = Flag.REDSUN_EXPERIMENTAL_TOOL_RESULT_REPLAY_MAX_CHARS ?? DEFAULT_TOOL_RESULT_REPLAY_MAX_CHARS
    let seen = 0
    let chars = 0

    return [...messages].reverse().map((message) => {
      if (!Array.isArray(message.content)) return message
      const content = [...message.content].reverse().map((part: any) => {
        if (!isToolResultPart(part)) return part
        seen++
        const length = contentTextLength(part)
        const keep = seen <= DEFAULT_TOOL_RESULT_REPLAY_KEEP_RECENT || chars + length <= maxChars
        chars += length
        return keep ? part : shortenedToolPart(part)
      }).reverse()
      return { ...message, content } as ModelMessage
    }).reverse()
  }

  function isCustomMessage(message: ModelMessage) {
    const text = messageText(message)
    return text.includes("[custom:")
  }

  export function limitCustomMessages(messages: ModelMessage[]): ModelMessage[] {
    const maxChars = Flag.REDSUN_EXPERIMENTAL_CUSTOM_MESSAGE_MAX_CHARS ?? DEFAULT_CUSTOM_MESSAGE_MAX_CHARS
    let chars = 0
    const keep = new Set<number>()

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (!isCustomMessage(message)) {
        keep.add(index)
        continue
      }
      const size = messageText(message).length
      if (chars + size <= maxChars) {
        chars += size
        keep.add(index)
      }
    }

    const result: ModelMessage[] = []
    const omitted = messages.filter((_, index) => !keep.has(index)).length
    let markerAdded = false
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (keep.has(index)) {
        result.push(message)
      } else {
        if (!markerAdded) {
          result.push({
            role: "user",
            content: [{ type: "text" as const, text: `${CUSTOM_OMITTED} omitted_messages: ${omitted}` }],
          })
          markerAdded = true
        }
      }
    }

    return result
  }

  export function optimizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
    return limitToolResultReplay(limitCustomMessages(messages))
  }

  export async function writeBreakdown(input: { sessionID: string; messageID: string; breakdown: Breakdown }) {
    await Storage.write(["context_breakdown", input.sessionID, input.messageID], {
      sessionID: input.sessionID,
      messageID: input.messageID,
      time: Date.now(),
      breakdown: input.breakdown,
    })
  }

  export async function readBreakdowns(sessionID: string) {
    const keys = await Storage.list(["context_breakdown", sessionID])
    return Promise.all(keys.map((key) => Storage.read<{ breakdown: Breakdown }>(key).catch(() => undefined))).then((items) =>
      items.filter((item): item is { breakdown: Breakdown } => !!item),
    )
  }

  export async function writeOpenAIResponse(input: { sessionID: string; messageID: string; providerID: string; modelID: string; responseID: string | null }) {
    if (!input.responseID) return
    await Storage.write(["openai_response", input.sessionID, input.messageID], {
      ...input,
      time: Date.now(),
    })
  }

  export async function lastOpenAIResponse(input: { sessionID: string; providerID: string; modelID: string }) {
    const keys = await Storage.list(["openai_response", input.sessionID])
    for (const key of keys.reverse()) {
      const item = await Storage.read<{ providerID: string; modelID: string; responseID: string }>(key).catch(() => undefined)
      if (item?.providerID === input.providerID && item.modelID === input.modelID) return item.responseID
    }
    return undefined
  }

  function messageText(message: ModelMessage) {
    if (typeof message.content === "string") return message.content
    if (!Array.isArray(message.content)) return JSON.stringify(message.content ?? "")
    return message.content
      .map((part: any) => {
        if (part.type === "text" || part.type === "reasoning") return part.text ?? ""
        if (part.type === "tool-call" || part.type === "tool-result") return JSON.stringify(part)
        if (part.type === "file" || part.type === "image") return part.url ?? part.image ?? ""
        return JSON.stringify(part)
      })
      .join("\n")
  }

  export function breakdown(input: { system: string[]; messages: ModelMessage[]; tools: Record<string, Tool> }) {
    let toolResult = 0
    let attachments = 0
    let customMessages = 0
    let message = 0

    for (const item of input.messages) {
      const text = messageText(item)
      const tokens = Token.estimate(text)
      if (text.includes("[custom:")) customMessages += tokens
      else {
        let categorized = 0
        if (Array.isArray(item.content)) {
          for (const part of item.content as any[]) {
            if (isToolResultPart(part)) {
              const count = Token.estimate(JSON.stringify(part))
              toolResult += count
              categorized += count
            }
            if (part.type === "file" || part.type === "image") {
              const count = Token.estimate(part.url ?? part.image ?? "")
              attachments += count
              categorized += count
            }
          }
        }
        message += Math.max(0, tokens - categorized)
      }
    }

    const tools = Object.values(input.tools).reduce((sum, tool) => sum + Token.estimate(JSON.stringify(tool)), 0)
    const system = input.system.reduce((sum, part) => sum + Token.estimate(part), 0)
    return {
      system,
      tools,
      messages: message,
      toolResults: toolResult,
      customMessages,
      attachments,
      total: system + tools + message + toolResult + customMessages + attachments,
    }
  }
}
