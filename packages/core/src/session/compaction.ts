export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { extract, serialize as serializeInventory } from "./compaction-inventory"

export { extract as extractInventory, serialize as serializeInventory } from "./compaction-inventory"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const DEFAULT_STRATEGY = "hybrid" as const
const DEFAULT_KEEP_RECENT = 4
const DEFAULT_MAX_TOOL_RESULTS = 30
const INVENTORY_MAX_CHARS = 32_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly strategy: "hybrid" | "algorithmic" | "llm"
  readonly keepRecent: number
  readonly maxToolResults: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      strategy: current.strategy ?? result.strategy,
      keepRecent: current.keepRecent ?? result.keepRecent,
      maxToolResults: current.maxToolResults ?? result.maxToolResults,
    }),
    {
      auto: true,
      buffer: DEFAULT_BUFFER,
      tokens: DEFAULT_KEEP_TOKENS,
      strategy: DEFAULT_STRATEGY,
      keepRecent: DEFAULT_KEEP_RECENT,
      maxToolResults: DEFAULT_MAX_TOOL_RESULTS,
    },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly headMessages: readonly SessionMessage.Message[]; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => ({ message: entry.message, text: serialize(entry.message) }))
    .filter((entry) => entry.text)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (next > tokens) {
      split = index + 1
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].text.slice(0, -remaining)
        splitSuffix = conversation[index].text.slice(-remaining)
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, split).map((entry) => entry.text), splitPrefix].filter(Boolean).join("\n\n"),
    headMessages: conversation.slice(0, split).map((entry) => entry.message),
    recent: [splitSuffix, ...conversation.slice(split).map((entry) => entry.text)].filter(Boolean).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

const bullets = (values: readonly string[]) => (values.length ? values.map((value) => `- ${value}`).join("\n") : "- (none)")

export function algorithmicSummary(input: { head: string; previousSummary?: string; maxToolResults?: number }) {
  const lines = input.head.split("\n").map((line) => line.trim()).filter(Boolean)
  const take = (prefix: string, max = 20) =>
    lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim()).filter(Boolean).slice(-max)
  const users = take("[User]:")
  const assistants = take("[Assistant]:")
  const calls = take("[Assistant tool call]:", input.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS)
  const errors = take("[Tool error]:", input.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS)
  const summary = [
    "## Objective",
    bullets(users.slice(-1)),
    "",
    "## Important Details",
    bullets([...(input.previousSummary ? [`Previous summary: ${input.previousSummary}`] : []), ...users.slice(0, -1)]),
    "",
    "## Work State",
    "### Completed",
    bullets([...assistants, ...calls]),
    "",
    "### Active",
    "- (none)",
    "",
    "### Blocked",
    bullets(errors),
    "",
    "## Next Move",
    "1. (none)",
    "2. (none)",
    "",
    "## Relevant Files",
    "- (none)",
  ].join("\n")
  return summary.length <= INVENTORY_MAX_CHARS ? summary : `${summary.slice(0, INVENTORY_MAX_CHARS)}\n[truncated]`
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const previous = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
    const source = [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head]
      .filter(Boolean)
      .join("\n\n")
    const extracted = serializeInventory(extract(selected.headMessages, config.maxToolResults))
    const inventory =
      extracted.length <= INVENTORY_MAX_CHARS ? extracted : `${extracted.slice(0, INVENTORY_MAX_CHARS)}\n[truncated]`
    const recent = [
      previousSummary?.type === "compaction" ? previousSummary.recent : "",
      ...selected.headMessages.slice(-config.keepRecent).map(serialize),
    ]
      .filter(Boolean)
      .join("\n\n")
    const algorithmic = [
      previous ? `## Previous Summary\n\n${previous}` : "",
      previousSummary?.type === "compaction" && previousSummary.recent
        ? `## Recent Exact Context\n\n${previousSummary.recent}`
        : "",
      inventory,
    ]
      .filter(Boolean)
      .join("\n\n")
    const summaryPrompt = buildPrompt({
      previousSummary: previous,
      context:
        config.strategy === "hybrid"
          ? [inventory ? `## Structured Inventory\n\n${inventory}` : "", recent].filter(Boolean)
          : [source],
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (config.strategy === "algorithmic" && !algorithmic.trim()) return false
    if (config.strategy !== "algorithmic" && Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    if (config.strategy === "algorithmic") {
      yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
        text: algorithmic,
        recent: selected.recent,
      })
      return true
    }

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
