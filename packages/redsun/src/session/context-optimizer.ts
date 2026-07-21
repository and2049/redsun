import type { ModelMessage, Tool } from "ai"
import type { Storage } from "@/storage/storage"
import { Token } from "@/util/token"

export namespace ContextOptimizer {
  export const FRAGMENT_MAX_CHARS = 24_000
  export const VOLATILE_MAX_CHARS = 12_000
  export const TOOL_RESULT_REPLAY_MAX_CHARS = 48_000
  export const TOOL_RESULT_REPLAY_KEEP_RECENT = 6

  const TOOL_REPLAY_OMITTED = "[redsun: older tool result omitted from model context]"

  export type Breakdown = {
    system: number
    tools: number
    messages: number
    toolResults: number
    customMessages: number
    attachments: number
    total: number
  }

  export function boundText(label: string, text: string, maxChars = FRAGMENT_MAX_CHARS) {
    if (text.length <= maxChars) return text
    const marker = `\n\n[redsun: ${label} truncated]`
    if (marker.length >= maxChars) return marker.slice(0, maxChars)
    return `${text.slice(0, maxChars - marker.length)}${marker}`
  }

  export function boundVolatile(label: string, text: string) {
    return boundText(label, text, VOLATILE_MAX_CHARS)
  }

  function isToolResult(part: unknown): part is Record<string, unknown> & { type: "tool-result" } {
    return !!part && typeof part === "object" && (part as { type?: string }).type === "tool-result"
  }

  function json(value: unknown) {
    try {
      return JSON.stringify(value) ?? ""
    } catch {
      return "[unserializable context item]"
    }
  }

  function omittedToolResult(part: Record<string, unknown>) {
    return {
      ...part,
      output: {
        type: "text",
        value: `${TOOL_REPLAY_OMITTED}\ntool_call: ${String(part.toolCallId ?? "unknown")}\nThe full result remains stored in the local session transcript.`,
      },
    }
  }

  export function limitToolResultReplay(
    messages: ModelMessage[],
    maxChars = TOOL_RESULT_REPLAY_MAX_CHARS,
    keepRecent = TOOL_RESULT_REPLAY_KEEP_RECENT,
  ): ModelMessage[] {
    let seen = 0
    let chars = 0
    return messages
      .toReversed()
      .map((message) => {
        if (!Array.isArray(message.content)) return message
        const content = message.content
          .toReversed()
          .map((part) => {
            if (!isToolResult(part)) return part
            seen++
            const size = json(part).length
            const keep = seen <= keepRecent || chars + size <= maxChars
            chars += size
            return keep ? part : omittedToolResult(part)
          })
          .toReversed()
        return { ...message, content } as ModelMessage
      })
      .toReversed()
  }

  export function optimizeModelMessages(messages: ModelMessage[]) {
    return limitToolResultReplay(messages)
  }

  function textOf(part: unknown) {
    if (!part || typeof part !== "object") return ""
    const value = part as Record<string, unknown>
    if (value.type === "text" || value.type === "reasoning") return String(value.text ?? "")
    return json(value)
  }

  export function breakdown(input: { system: string[]; messages: ModelMessage[]; tools: Record<string, Tool> }): Breakdown {
    let messages = 0
    let toolResults = 0
    let customMessages = 0
    let attachments = 0

    for (const message of input.messages) {
      if (message.role === "system") continue
      if (typeof message.content === "string") {
        const match = message.content.match(/<extension-context>[\s\S]*?<\/extension-context>/g)
        let normal = message.content
        for (const custom of match ?? []) {
          customMessages += Token.estimate(custom)
          normal = normal.replace(custom, "")
        }
        messages += Token.estimate(normal)
        continue
      }
      if (!Array.isArray(message.content)) {
        messages += Token.estimate(json(message.content ?? ""))
        continue
      }
      for (const part of message.content) {
        if (isToolResult(part)) {
          toolResults += Token.estimate(json(part))
          continue
        }
        if (part.type === "file" || part.type === "image") {
          attachments += Token.estimate(json(part))
          continue
        }
        const text = textOf(part)
        if (text.includes("<extension-context>")) customMessages += Token.estimate(text)
        else messages += Token.estimate(text)
      }
    }

    const system = input.system.reduce((sum, value) => sum + Token.estimate(value), 0)
    const tools = Object.values(input.tools).reduce((sum, value) => sum + Token.estimate(json(value)), 0)
    return {
      system,
      tools,
      messages,
      toolResults,
      customMessages,
      attachments,
      total: system + tools + messages + toolResults + customMessages + attachments,
    }
  }

  export function writeBreakdown(
    storage: Storage.Interface,
    input: { sessionID: string; messageID: string; breakdown: Breakdown },
  ) {
    return storage.write(["context_breakdown", input.sessionID, input.messageID], {
      ...input,
      time: Date.now(),
    })
  }
}
