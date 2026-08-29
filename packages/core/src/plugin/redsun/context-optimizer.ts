export * as RedsunContextOptimizer from "./context-optimizer.js"

import { Message, type ContentPart, type SystemPart } from "@opencode-ai/ai"
import { Document, type Entry } from "@opencode-ai/schema/config"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { ReadLocator } from "../../util/read-locator.js"

export const INSTRUCTION_MAX_CHARS = 24_000
export const STALE_READ_REWRITE_MIN_CHARS = 65_536

const INSTRUCTION_HEADER = "Instructions from: "

const json = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable context item]"
  }
}

const staleRead = (part: ContentPart & { type: "tool-result" }, file: string): ContentPart => ({
  ...part,
  result: {
    type: "text",
    value: `[redsun: superseded by a later read of ${file}; see the latest read result]`,
  },
})

/**
 * Replace read results superseded by a later read of the same path and range with a short
 * pointer. Results are never removed, so tool-call pairing stays intact. Rewrites are
 * deferred until the superseded results total at least minChars: history only grows, so the
 * decision is monotone and provider prefix caches survive between crossings.
 */
export const dedupeStaleReads = (messages: Array<Message>, minChars = STALE_READ_REWRITE_MIN_CHARS): Array<Message> => {
  const calls = messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === "tool-call" ? [{ id: part.id, name: part.name, input: part.input }] : [],
    ),
  )
  const stale = ReadLocator.stale(calls)
  if (stale.size === 0) return messages
  const inputs = new Map(calls.map((call) => [call.id, call.input]))
  const results = messages.flatMap((message) =>
    message.content.filter((part) => part.type === "tool-result" && stale.has(part.id)),
  )
  if (results.reduce((total, part) => total + json(part).length, 0) < minChars) return messages
  return messages.map((message) => {
    if (!message.content.some((part) => part.type === "tool-result" && stale.has(part.id))) return message
    const content = message.content.map((part) =>
      part.type === "tool-result" && stale.has(part.id)
        ? staleRead(part, ReadLocator.path(inputs.get(part.id)) ?? "the same file")
        : part,
    )
    return Message.make({
      id: message.id,
      role: message.role,
      content,
      metadata: message.metadata,
      native: message.native,
    })
  })
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
  return Message.make({
    id: message.id,
    role: message.role,
    content,
    metadata: message.metadata,
    native: message.native,
  })
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
        event.messages = dedupeStaleReads(event.messages).map((message) => boundMessage(message, maxChars))
      }),
    )
  }),
})
