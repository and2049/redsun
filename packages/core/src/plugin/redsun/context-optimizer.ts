export * as RedsunContextOptimizer from "./context-optimizer.js"

import { Message, type ContentPart, type SystemPart } from "@opencode-ai/ai"
import { Document, type Entry } from "@opencode-ai/schema/config"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"

export const INSTRUCTION_MAX_CHARS = 24_000
export const TOOL_RESULT_REPLAY_MAX_CHARS = 48_000
export const TOOL_RESULT_REPLAY_KEEP_RECENT = 6

const TOOL_REPLAY_OMITTED = "[redsun: older tool result omitted from model context]"
const INSTRUCTION_HEADER = "Instructions from: "

const json = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable context item]"
  }
}

const omittedToolResult = (part: ContentPart & { type: "tool-result" }): ContentPart => ({
  ...part,
  result: {
    type: "text",
    value: `${TOOL_REPLAY_OMITTED}\ntool_call: ${part.id}\nThe full result remains stored in the local session transcript.`,
  },
})

/**
 * Bound the aggregate size of replayed tool results. The newest keepRecent results are
 * unconditionally preserved; older results are replaced (never removed, so tool-call
 * pairing stays intact) once the running total exceeds maxChars. Dropped results still
 * count toward the total on purpose — it keeps the cutoff monotone.
 */
export const limitToolResultReplay = (
  messages: Array<Message>,
  maxChars = TOOL_RESULT_REPLAY_MAX_CHARS,
  keepRecent = TOOL_RESULT_REPLAY_KEEP_RECENT,
): Array<Message> => {
  let seen = 0
  let chars = 0
  return messages
    .toReversed()
    .map((message) => {
      if (!message.content.some((part) => part.type === "tool-result")) return message
      const content = message.content
        .toReversed()
        .map((part) => {
          if (part.type !== "tool-result") return part
          seen++
          const size = json(part).length
          const keep = seen <= keepRecent || chars + size <= maxChars
          chars += size
          return keep ? part : omittedToolResult(part)
        })
        .toReversed()
      return Message.make({ id: message.id, role: message.role, content, metadata: message.metadata, native: message.native })
    })
    .toReversed()
}

/**
 * Truncate one instruction block (`Instructions from: <path>\n<content>`) at a line
 * boundary with a visible marker naming the source and how to read the rest. Marker
 * space is reserved for the worst-case line number so output never exceeds maxChars.
 */
export const boundInstruction = (filepath: string, text: string, maxChars = INSTRUCTION_MAX_CHARS) => {
  const header = `${INSTRUCTION_HEADER}${filepath}\n`
  if (header.length + text.length <= maxChars) return `${header}${text}`

  const isUrl = filepath.startsWith("http://") || filepath.startsWith("https://")
  const totalLines = text.split("\n").length
  const marker = (line: number) =>
    isUrl
      ? `\n[redsun: instructions truncated at line ${line} of ${totalLines} (${maxChars} char limit). Full content: ${filepath}]`
      : `\n[redsun: instructions truncated at line ${line} of ${totalLines} (${maxChars} char limit). Read the remainder with the read tool: ${filepath} offset=${line + 1}.]`

  const budget = maxChars - header.length - marker(totalLines).length
  if (budget <= 0) return `${header}${marker(0)}`.slice(0, maxChars)

  const slice = text.slice(0, budget)
  const cut = slice.lastIndexOf("\n")
  const kept = cut > 0 ? slice.slice(0, cut) : slice
  const keptLines = kept.split("\n").length
  return `${header}${kept}${marker(keptLines)}`
}

/**
 * Bound every `Instructions from:` block inside a text value. Blocks that were already
 * truncated stay under the cap, so a second pass is a no-op.
 */
export const boundInstructionText = (text: string, maxChars = INSTRUCTION_MAX_CHARS) => {
  if (!text.includes(INSTRUCTION_HEADER)) return text
  const segments = text.split(new RegExp(`(?=^${INSTRUCTION_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "m"))
  return segments
    .map((segment) => {
      if (!segment.startsWith(INSTRUCTION_HEADER)) return segment
      const trailing = segment.match(/\n*$/)?.[0] ?? ""
      const block = trailing ? segment.slice(0, -trailing.length) : segment
      const newline = block.indexOf("\n")
      if (newline < 0) return segment
      const filepath = block.slice(INSTRUCTION_HEADER.length, newline)
      const content = block.slice(newline + 1)
      return boundInstruction(filepath, content, maxChars) + trailing
    })
    .join("")
}

const instructionMaxChars = (entries: readonly Entry[]) =>
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => (entry.info.instruction_max_chars !== undefined ? [entry.info.instruction_max_chars] : []))
    .at(-1) ?? INSTRUCTION_MAX_CHARS

const boundMessage = (message: Message, maxChars: number) => {
  if (!message.content.some((part) => part.type === "text" && part.text.includes(INSTRUCTION_HEADER))) return message
  const content = message.content.map((part) =>
    part.type === "text" ? { ...part, text: boundInstructionText(part.text, maxChars) } : part,
  )
  return Message.make({ id: message.id, role: message.role, content, metadata: message.metadata, native: message.native })
}

const boundSystem = (part: SystemPart, maxChars: number): SystemPart =>
  part.text.includes(INSTRUCTION_HEADER) ? { ...part, text: boundInstructionText(part.text, maxChars) } : part

export const Plugin = define({
  id: "redsun.session.context-optimizer",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const maxChars = instructionMaxChars(yield* config.entries())
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        event.system = event.system.map((part) => boundSystem(part, maxChars))
        event.messages = limitToolResultReplay(event.messages).map((message) => boundMessage(message, maxChars))
      }),
    )
  }),
})
